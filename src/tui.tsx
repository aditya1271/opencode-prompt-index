import type { SessionMessageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { Index, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"

interface Prefs {
  expanded: boolean
}

interface Prompt {
  id: string
  number: number
  label: string
}

/** The parts of OpenTUI's ScrollBoxRenderable and its rows that jumping uses. */
interface TranscriptRow {
  readonly id: string
  readonly y: number
  readonly height: number
  readonly isDestroyed: boolean
}

interface Transcript {
  readonly isDestroyed: boolean
  readonly scrollTop: number
  readonly content: { readonly y: number }
  stickyScroll: boolean
  scrollTo(position: number): void
  getChildren(): TranscriptRow[]
  getRenderable(id: string): TranscriptRow | undefined
}

/** Rows per sidebar page. Rendering every prompt at once makes the TUI stall on long sessions. */
const PAGE_ROWS = 15
/** How long to wait for the transcript to render an older prompt before falling back to stepping. */
const RENDER_TIMEOUT_MS = 10000
/** How long to keep the jump target in place against scrolls the transcript had already queued. */
const SETTLE_MS = 400
const POLL_MS = 16

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isScrollBox = (node: unknown): node is Transcript => {
  const box = node as Partial<Transcript> | undefined
  return (
    typeof box?.getRenderable === "function" &&
    typeof box.scrollTo === "function" &&
    typeof box.scrollTop === "number" &&
    typeof box.content?.y === "number"
  )
}

const resolveColor = (theme: unknown, tokenPath: string, fallback: string) => {
  const value = tokenPath.split(".").reduce<any>((acc, key) => acc?.[key], theme)
  return value ?? fallback
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/\s+/g, " ") ?? ""

/**
 * Prompts numbered the way the TUI's own "user message" navigation counts them: user messages with non-empty text.
 * `fetched` are the session's user messages from the server; `cached` is the TUI's message list, which holds only the
 * newest page after a restart but also has prompts sent since the fetch. Messages from a staged revert onward are hidden
 * in the transcript, so they are left out too.
 */
const promptsOf = (
  fetched: readonly SessionMessageInfo[],
  cached: readonly SessionMessageInfo[],
  revertID: string | undefined,
  previous: ReadonlyMap<string, Prompt>,
): Prompt[] => {
  const byID = new Map<string, SessionMessageInfo>()
  for (const message of fetched) byID.set(message.id, message)
  for (const message of cached) if (message.type === "user") byID.set(message.id, message)
  const revertAt = revertID
    ? (cached.find((message) => message.id === revertID) ?? byID.get(revertID))?.time.created
    : undefined
  const shown = [...byID.values()]
    .filter((message) => revertAt === undefined || message.time.created < revertAt)
    .sort((a, b) => a.time.created - b.time.created)
  const prompts: Prompt[] = []
  for (const message of shown) {
    if (message.type !== "user" || !message.text.trim()) continue
    const number = prompts.length + 1
    // Reuse unchanged entries so the sidebar keeps their rows instead of rebuilding every row on each refresh.
    const known = previous.get(message.id)
    prompts.push(known?.number === number ? known : { id: message.id, number, label: firstLine(message.text) })
  }
  return prompts
}

export default Plugin.define({
  id: "prompt-index.tui",
  setup(context) {
    const [prefs, setPrefs] = context.storage.store<Prefs>("prefs", {
      initial: { expanded: true },
    })
    const updatePrefs = (mutate: (draft: Prefs) => void) => void setPrefs(mutate).catch(() => {})

    const color = {
      header: () => resolveColor(context.theme, "text.base", "#eeffff"),
      muted: () => resolveColor(context.theme, "text.muted", "#546e7a"),
      accent: () => resolveColor(context.theme, "text.action.primary.selected", "#82aaff"),
    }

    /**
     * Fallback when the transcript can't be reached directly: drive the built-in navigation, jumping to the last prompt
     * and stepping back one prompt at a time. Correct but slow on long jumps, since every step re-sorts the transcript.
     */
    const stepTo = (prompts: readonly Prompt[], target: Prompt) => {
      context.keymap.dispatch("session.messages_last_user")
      for (let step = prompts.length - target.number; step > 0; step--) {
        context.keymap.dispatch("session.message.user.previous")
      }
    }

    /**
     * The plugin API has no "scroll to message", but the transcript is a scrollbox whose rows for user prompts carry
     * the message ID as their renderable ID. So the plugin finds that row and scrolls to it, the same way the built-in
     * navigation does. The transcript only renders its latest rows; for an older prompt one built-in jump makes it render
     * the whole session first (the same one-time cost as /timeline), then the plugin scrolls to the row.
     */
    let transcript: { box: Transcript; sessionID: string } | undefined
    let jumpSeq = 0

    const findTranscript = (sessionID: string) => {
      if (transcript && transcript.sessionID === sessionID && !transcript.box.isDestroyed) return transcript.box
      transcript = undefined
      const stack: unknown[] = [context.renderer.root]
      while (stack.length) {
        const node = stack.pop() as { getChildren?: () => unknown[] } | undefined
        if (isScrollBox(node) && isTranscriptOf(node, sessionID)) {
          transcript = { box: node, sessionID }
          return node
        }
        if (node?.getChildren) stack.push(...node.getChildren())
      }
      return undefined
    }

    const isTranscriptOf = (box: Transcript, sessionID: string) => {
      const ids = new Set((context.data.session.message.list(sessionID) ?? []).map((message) => message.id))
      return box.getChildren().some((row) => {
        const id = typeof row?.id === "string" ? row.id : ""
        return ids.has(id) || (id.startsWith("session-part:") && ids.has(id.split(":")[1]))
      })
    }

    const renderedRow = (sessionID: string, messageID: string) => {
      const row = findTranscript(sessionID)?.getRenderable(messageID)
      return row && !row.isDestroyed && row.height > 0 ? row : undefined
    }

    /**
     * Scrolls the row to the top of the transcript. Its offset within the scrolled content comes from one layout pass,
     * so it stays valid after a scrollTo whose new layout hasn't been drawn yet. Returns whether a scroll was needed.
     */
    const scrollToRow = (box: Transcript, row: TranscriptRow) => {
      const top = Math.max(0, row.y - box.content.y)
      if (Math.abs(box.scrollTop - top) < 1) return false
      box.stickyScroll = false
      box.scrollTo(top)
      return true
    }

    /** Every user message of the session, oldest first, straight from the server (200 per page). */
    const fetchUserMessages = async (sessionID: string) => {
      const all: SessionMessageInfo[] = []
      let cursor: string | undefined
      do {
        const page = await context.client.message.list(
          cursor ? { sessionID, type: "user", limit: 200, cursor } : { sessionID, type: "user", limit: 200, order: "asc" },
        )
        all.push(...page.data)
        cursor = page.cursor.next ?? undefined
      } while (cursor)
      return all
    }

    /**
     * After a restart the TUI holds only the newest page of messages and loads older ones as you scroll up. Its store
     * (the same object as context.data) can load them all at once, as the built-in "jump to first message" does;
     * that method isn't in the plugin types, so it's used only when present.
     */
    const loadAllMessages = async (sessionID: string) => {
      const store = context.data.session.message as unknown as {
        more?: (sessionID: string) => boolean
        loadMore?: (sessionID: string, options?: { all?: boolean }) => Promise<void>
      }
      if (store.more?.(sessionID) && store.loadMore) await store.loadMore(sessionID, { all: true })
    }

    const jumpTo = async (sessionID: string, prompts: readonly Prompt[], target: Prompt) => {
      const mine = ++jumpSeq
      if (!context.data.session.message.get(sessionID, target.id)) {
        await loadAllMessages(sessionID).catch(() => {})
        if (mine !== jumpSeq) return
      }
      if (!findTranscript(sessionID)) return stepTo(prompts, target)

      const visible = renderedRow(sessionID, target.id)
      if (visible) return void scrollToRow(findTranscript(sessionID)!, visible)

      // Makes the transcript render every row, then scroll to the last prompt a few frames later.
      context.keymap.dispatch("session.messages_last_user")
      const deadline = Date.now() + RENDER_TIMEOUT_MS
      while (!renderedRow(sessionID, target.id)) {
        if (Date.now() >= deadline) return stepTo(prompts, target)
        await sleep(POLL_MS)
        if (mine !== jumpSeq) return
      }

      // Re-apply for a short while so the scroll the transcript still has queued doesn't move us off the prompt.
      const settleUntil = Date.now() + SETTLE_MS
      for (;;) {
        const box = findTranscript(sessionID)
        const row = renderedRow(sessionID, target.id)
        if (!box || !row) return
        scrollToRow(box, row)
        if (Date.now() >= settleUntil) return
        await sleep(POLL_MS)
        if (mine !== jumpSeq) return
      }
    }

    /**
     * Acts on mouse release, like OpenCode's own buttons. A dialog opened on press could be drawn before the release
     * (likely while a reply streams), and the release would then land on the dialog's backdrop and close it.
     */
    function Clickable(props: { onClick: () => void; children: any }) {
      return (
        <box
          flexDirection="row"
          onMouseDown={(event: { stopPropagation(): void }) => event.stopPropagation()}
          onMouseUp={(event: { stopPropagation(): void }) => {
            event.stopPropagation()
            props.onClick()
          }}
        >
          {props.children}
        </box>
      )
    }

    function PromptRow(props: { prompt: Prompt; numberWidth: number; active: boolean; onJump: () => void }) {
      const [hover, setHover] = createSignal(false)
      const number = () => String(props.prompt.number).padStart(props.numberWidth)
      return (
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          overflow="hidden"
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseDown={(event: { stopPropagation(): void }) => {
            event.stopPropagation()
            props.onJump()
          }}
        >
          <text flexShrink={0} fg={props.active ? color.accent() : color.muted()}>
            {`${props.active ? "›" : " "}${number()} `}
          </text>
          {/* One line, cut to the sidebar's real width, so every row is exactly one line tall. */}
          <text
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
            fg={hover() || props.active ? color.accent() : color.header()}
          >
            {props.prompt.label}
          </text>
        </box>
      )
    }

    function PromptIndexSection(props: { sessionID: string }) {
      const [tick, setTick] = createSignal(0)
      const [jumpedID, setJumpedID] = createSignal<string>()
      const [page, setPage] = createSignal(0)
      // User messages from the server, so prompts older than the TUI's loaded page still show after a restart.
      const [fetched, setFetched] = createSignal<{ sessionID: string; messages: SessionMessageInfo[] }>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let fetchSeq = 0

      const refresh = () => {
        clearTimeout(timer)
        timer = setTimeout(() => setTick((n) => n + 1), 100)
      }

      const refetch = (sessionID: string) => {
        const mine = ++fetchSeq
        fetchUserMessages(sessionID).then(
          (messages) => {
            if (mine !== fetchSeq) return
            setFetched({ sessionID, messages })
            refresh()
          },
          // Keep the last list; the TUI's own cache still covers recent prompts.
          () => {},
        )
      }

      createEffect(
        on(
          () => props.sessionID,
          (sessionID) => {
            setJumpedID(undefined)
            setPage(0)
            refresh()
            void context.data.session.message.sync(sessionID).then(refresh, () => {})
            refetch(sessionID)
          },
        ),
      )

      const forThisSession = (event: { data: { sessionID: string } }) => {
        if (event.data.sessionID === props.sessionID) refresh()
      }
      const refetchThisSession = (event: { data: { sessionID: string } }) => {
        if (event.data.sessionID !== props.sessionID) return
        refresh()
        refetch(props.sessionID)
      }
      const stops = [
        context.data.on("session.inbox.delivered", refetchThisSession),
        context.data.on("session.execution.started", forThisSession),
        context.data.on("session.execution.succeeded", refetchThisSession),
        context.data.on("session.revert.staged", refetchThisSession),
        context.data.on("session.revert.cleared", refetchThisSession),
        context.data.on("session.revert.committed", refetchThisSession),
      ]
      onCleanup(() => {
        clearTimeout(timer)
        for (const stop of stops) stop()
      })

      // Recomputed only on the debounced refresh tick, not on every store update while a reply streams.
      const prompts = createMemo<Prompt[]>((previous) => {
        tick()
        const sessionID = props.sessionID
        return untrack(() => {
          const cached = context.data.session.message.list(sessionID) ?? []
          const server = fetched()
          const known = new Map(previous.map((prompt) => [prompt.id, prompt]))
          return promptsOf(
            server?.sessionID === sessionID ? server.messages : [],
            cached,
            context.data.session.get(sessionID)?.revert?.messageID,
            known,
          )
        })
      }, [])
      // Pages of PAGE_ROWS, newest first. Page 0 holds the latest prompts.
      const pageCount = () => Math.max(Math.ceil(prompts().length / PAGE_ROWS), 1)
      const currentPage = () => Math.min(page(), pageCount() - 1)
      const visible = createMemo(() => {
        const all = prompts()
        const end = all.length - currentPage() * PAGE_ROWS
        return all.slice(Math.max(end - PAGE_ROWS, 0), end).reverse()
      })
      const numberWidth = () => String(prompts().length).length
      // Padded to the widest range for this session, so the pager buttons stay put while paging.
      const range = () => {
        const shown = visible()
        const total = prompts().length
        const widest = `${total}–${total} of ${total}`.length
        const text = shown.length ? `${shown[shown.length - 1].number}–${shown[0].number} of ${total}` : ""
        return text.padStart(widest)
      }

      const jump = (prompt: Prompt) => {
        setJumpedID(prompt.id)
        void jumpTo(props.sessionID, prompts(), prompt)
      }

      const openSearch = async () => {
        const all = prompts()
        if (!all.length) return
        const id = await context.ui.dialog.select<string>({
          title: `Jump to prompt (${all.length})`,
          placeholder: "Search prompts",
          current: jumpedID(),
          options: all
            .slice()
            .reverse()
            .map((prompt) => ({ title: `${prompt.number}. ${prompt.label}`, value: prompt.id })),
        })
        const target = id && prompts().find((prompt) => prompt.id === id)
        // Let the dialog close and hand focus back to the session before driving its navigation.
        if (target) setTimeout(() => jump(target), 0)
      }

      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "prompt-index.search",
            title: "Jump to prompt",
            group: "Session",
            palette: true,
            slash: { name: "prompts" },
            run: () => void openSearch(),
          },
        ],
      }))

      return (
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <Clickable onClick={() => updatePrefs((draft) => void (draft.expanded = !draft.expanded))}>
            <text fg={color.header()}>{`${prefs.expanded ? "▼" : "▶"} Prompts `}</text>
            <Show when={prompts().length > 0} fallback={<text fg={color.muted()}>{"· none yet"}</text>}>
              <text fg={color.muted()}>{String(prompts().length)}</text>
            </Show>
          </Clickable>
          <Show when={prefs.expanded && prompts().length > 0}>
            <Clickable onClick={() => void openSearch()}>
              <text fg={color.accent()}>{"⌕ Search all"}</text>
              <text fg={color.muted()}>{" /prompts"}</text>
            </Clickable>
            {/* Fixed height once there are several pages, so the pager below never moves; scrolls if rows overflow. */}
            <scrollbox
              height={pageCount() > 1 ? PAGE_ROWS : visible().length}
              flexShrink={0}
              horizontalScrollbarOptions={{ visible: false }}
            >
              {/* Index keeps one row per slot and updates its text, so paging never rebuilds rows. */}
              <Index each={visible()}>
                {(prompt) => (
                  <PromptRow
                    prompt={prompt()}
                    numberWidth={numberWidth()}
                    active={jumpedID() === prompt().id}
                    onJump={() => jump(prompt())}
                  />
                )}
              </Index>
            </scrollbox>
            <Show when={pageCount() > 1}>
              <box flexDirection="row">
                <Clickable onClick={() => setPage(Math.max(currentPage() - 1, 0))}>
                  <text fg={currentPage() > 0 ? color.accent() : color.muted()}>{"◀ newer"}</text>
                </Clickable>
                <text fg={color.muted()}>{` ${range()} `}</text>
                <Clickable onClick={() => setPage(Math.min(currentPage() + 1, pageCount() - 1))}>
                  <text fg={currentPage() < pageCount() - 1 ? color.accent() : color.muted()}>{"older ▶"}</text>
                </Clickable>
              </box>
            </Show>
          </Show>
        </box>
      )
    }

    const render = (input: { sessionID: string }) => <PromptIndexSection sessionID={input.sessionID} />
    return (context.options as { position?: unknown } | undefined)?.position === "bottom"
      ? context.ui.slot({ append: "sidebar.content", render })
      : context.ui.slot({ prepend: "sidebar.content", render })
  },
})
