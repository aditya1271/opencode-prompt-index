# opencode-prompt-index

An [OpenCode](https://opencode.ai) V2 TUI plugin that adds a numbered index of your prompts to the sidebar. Click a
prompt to jump the transcript to it.

```
▼ Prompts 120
⌕ Search all /prompts
 120 write the README
 ...
›110 why does test_foo fail on linux
 ...
 106 refactor the parser to use visitors
◀ newer 106–120 of 120 older ▶
```

## Features

- **Numbered list** of the prompts in the current session, newest first. Each row is one line: the prompt's first
  line, cut off with `…` at the sidebar's width.
- **Click to jump**: the transcript scrolls straight to that prompt. The row you last jumped to is marked with `›`.
- **Pages of 15**: `◀ newer` / `older ▶` move through the list. Only one page is drawn at a time, so the sidebar stays
  fast in sessions with hundreds of prompts. The list has a fixed height, so the pager buttons stay in the same place on
  every page and you can keep clicking without moving the mouse.
- **Search**: `⌕ Search all` (at the top of the section), `/prompts`, or **Jump to prompt** in the command palette
  opens a searchable list of every prompt. Pick one to jump to it.
- **Collapsible**: click the `▼ Prompts` header to collapse the section. This is saved across restarts.
- **Revert aware**: prompts hidden by `/undo` are left out.

## Install

This plugin is TUI-only, so register it in `~/.config/opencode/cli.json`, not `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/home/<you>/github/opencode-prompt-index"]
}
```

For local development, install the dev dependencies for typechecking:

```sh
npm install --legacy-peer-deps
npm run typecheck
```

## Options

```json
{
  "plugins": [
    { "package": "/home/<you>/github/opencode-prompt-index", "options": { "position": "bottom" } }
  ]
}
```

- `position`: `"bottom"` puts the section after the other sidebar sections. By default it goes first.

## How jumping works

The plugin API has no "scroll to message" call. The transcript is an OpenTUI scrollbox, and its row for each prompt has
the message ID as its renderable ID, so the plugin finds that row and scrolls the transcript to it directly.

- **Prompt already rendered** (recent prompts): one direct scroll, instant.
- **Older prompt**: OpenCode only renders the latest part of a long transcript. The plugin runs
  `session.messages_last_user` once, which makes OpenCode render the whole session, then scrolls to the row. That
  render is a one-time cost, the same as going far back with `/timeline`. It stays rendered while you're scrolled up,
  so later jumps are instant again until you return to the bottom.
- **Fallback**: if the transcript can't be found, for example after an OpenCode update changes its layout, the plugin
  steps there with `session.message.user.previous`, which is correct but slow for long jumps.

This relies on OpenCode's internal transcript layout rather than a public API, so a future OpenCode version could
change it. The fallback keeps jumping working if that happens.

## Compared with `/timeline`

OpenCode has a built-in `/timeline` dialog (`<leader>g`) that also lists your prompts and scrolls to one. Both use the
same transcript, so a far jump costs the same one-time render either way. The difference is how you get to the list:

| | `/timeline` | Prompt index |
|---|---|---|
| Where | Modal dialog: open it, pick, close it | Always visible in the sidebar |
| Jump | Select with arrows or search, then close | One click |
| Numbering | None | Each prompt numbered (`#42`), so you can find it again |
| Orientation | List only while the dialog is open | `›` marks where you last jumped while you read |
| Long sessions | One long list | Pages of 15 with a fixed-height list, plus search |
| Extra actions | Fork from or copy a message | None, it only navigates |
| `/undo` | | Reverted prompts are left out |

Use `/timeline` when you want to fork or copy from a message. Use the index to move around a long session while you
work, keeping the outline in view.
