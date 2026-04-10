<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="340" />
</p>

<p align="center"><em>A coding agent at the tip of your cursor</em></p>

> You don't need to own every keystroke — but you do need to own the expression of your intent. And that happens at the file level, where you're closest to the code.

CodeSpark combines two complementary agents into one workflow: a fast **inline agent** for editing code at your cursor, and a powerful **research agent** backed by Claude Code for deep codebase exploration and web search. The inline agent replaces the mechanical parts — searching, boilerplate, repetitive edits — while the research agent gives you a way to understand before you change.

This isn't a replacement for Claude Code — it's a different mode of working. Claude Code is a project-level tool: great for large refactors, scaffolding, and tasks where you want the agent to drive. CodeSpark is for when you want to stay in the driver's seat. You're the one navigating the codebase, deciding what to change, building your understanding. The agents handle the mechanics so you can focus on intent.

![CodeSpark in action](./media/screenshot.png)

## Getting started

1. Install CodeSpark Extension: [Install in VSCode](vscode:extension/codespark.codespark-agent)
2. Set `codeSpark.apiKey` in settings. You get one from [Claude Console](https://platform.claude.com/settings/workspaces/default/keys)

## How it works

**Inline agent** (`Cmd+I`) — A lightweight agent powered by [pi.dev](https://pi.dev), optimized for speed. It works from your cursor, editing the file you're looking at. Most edits are fast, single-turn, file-scoped changes. When the task demands it, the agent reads additional files and goes as wide as it needs — but it always stays within the code, never running commands or reaching outside the project.

**Research agent** (`Cmd+Shift+I`) — Powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), this is Claude Code running as a dedicated research tool. It can read files, grep through your codebase, search the web, and fetch documentation — but it cannot edit anything. Every conversation automatically builds context that the inline agent picks up on its next invocation.

The two agents are connected: ask a question in the research panel, and the next time you invoke the inline agent, it knows what you learned.

## Shortcuts

| Mac           | Windows / Linux | What it does                                                                                                      |
| ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Cmd+I`       | `Ctrl+I`        | Open the inline agent — describe a change and it edits the file at your cursor                                    |
| `Cmd+Shift+I` | `Ctrl+Shift+I`  | Open the research agent — attaches the current file and cursor position as context when the panel is already open |

These shortcuts may conflict with other extensions (e.g. GitHub Copilot uses the same bindings). To rebind them, open the command palette and search for "Preferences: Open Keyboard Shortcuts (JSON)", then add your preferred bindings:

**Mac** — `Cmd+Shift+P` > "Preferences: Open Keyboard Shortcuts (JSON)"

```json
[
  { "key": "cmd+i", "command": "codeSpark.invoke", "when": "editorTextFocus" },
  { "key": "cmd+shift+i", "command": "codeSpark.openResearch" }
]
```

**Windows / Linux** — `Ctrl+Shift+P` > "Preferences: Open Keyboard Shortcuts (JSON)"

```json
[
  { "key": "ctrl+i", "command": "codeSpark.invoke", "when": "editorTextFocus" },
  { "key": "ctrl+shift+i", "command": "codeSpark.openResearch" }
]
```

## Project context

Context is progressively included starting from where your cursor is. Sometimes the code at the cursor is enough. Other times it needs the surrounding block, the full file, your `CLAUDE.md` / `AGENT.md` files and any resources they reference, or research from the sidebar. This progressive approach is optimized for keeping context small and relevant — but when the task demands it, the agent will explore additional files and go as wide as it needs on its own.

You can link to files and directories from your `CLAUDE.md` and `AGENT.md` files. Linked files are read into context so the agent understands their contents. Linked directories are expanded to show their filenames, giving the agent awareness of the project structure without loading every file.
