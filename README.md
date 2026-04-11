<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="340" />
</p>

<p align="center"><em>Claude Code at the tip of your cursor</em></p>

> Claude Code in the terminal is powerful — but the agent is in the driver's seat. CodeSpark flips that dynamic. It brings Claude Code into your editor where **you** are in control: you navigate, you decide what to change, you build understanding. The agent handles the mechanics.

CodeSpark is a first-class Claude Code experience inside VS Code. It runs the Claude Code CLI under the hood, giving you the same models, tools, and `CLAUDE.md` context — but scoped to what you're looking at. Two agents, one workflow: a fast **inline agent** for editing code at your cursor, and a **research agent** for deep codebase exploration and web search.

When you hand everything to an agent, you don't just lose control — you lose context. The agent builds its understanding of the codebase, but you don't build yours. Every file you navigate to, every change you reason about, every decision you make strengthens your own mental model. That's not overhead — it's how you stay effective. CodeSpark keeps you in those low-level, practical interactions where learning happens, while removing the mechanical friction that slows you down.

![CodeSpark in action](./media/screenshot.png)

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- No separate API key required — CodeSpark uses your existing Claude Code setup

## Getting started

1. Install the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and authenticate (`claude` in your terminal)
2. Install the CodeSpark extension: [Install in VS Code](vscode:extension/codespark.codespark-agent)
3. **Restart VS Code** after installing Claude Code so the extension can find the `claude` binary in your PATH

## How it works

### Inline agent (`Cmd+I` / `Ctrl+I`)

Powered by Claude Code running Haiku, optimized for speed. It works from your cursor, editing the file you're looking at. Most edits are fast, single-turn, file-scoped changes. When the task demands it, the agent reads and writes additional files and goes as wide as it needs — but it always stays within the code, never running commands or reaching outside the project.

- The current file content and cursor position
- The closest `CLAUDE.md` in the directory hierarchy (from the file's directory up to the workspace root)
- Any files linked from those `CLAUDE.md` files (read into context)
- Any directories linked from those `CLAUDE.md` files (expanded as file listings)
- The latest research summary from the research agent

### Research agent (`Cmd+Shift+I` / `Ctrl+Shift+I`)

Powered by Claude Code, this is a dedicated research tool. It can read files, grep through your codebase, search the web, and fetch documentation — but it cannot edit anything. When the research panel is already open, invoking it again attaches the current file and cursor position as context.

The output is integrated with VS Code: file paths like `src/foo.ts:42` become clickable links that open the file at that line, and fenced code blocks with `bash` render with a run button that executes the command in your terminal.

The two agents are connected: ask a question in the research panel, and the next time you invoke the inline agent, it knows what you learned.

### CLAUDE.md

`CLAUDE.md` files are how you control agent behavior. Place one at the workspace root for project-wide instructions, and add more in subdirectories for domain-specific guidance. When you invoke the inline agent, it picks up the root `CLAUDE.md` plus the closest one in the directory hierarchy above the file you're editing.

This is the same `CLAUDE.md` convention used by Claude Code in the terminal. Instructions you write for CodeSpark — patterns, conventions, constraints, preferred libraries — also improve Claude Code when you use it from the CLI. You're not maintaining two configurations; you're building one set of instructions that makes the agent better everywhere.

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

## Inline agent performance

The inline agent is optimized for low-latency edits (~1.5–2s typical). Here's how:

**Long-lived MCP server.** The MCP server that bridges the Claude CLI and VS Code uses Streamable HTTP transport, started once at extension activation. Each CLI invocation connects to the already-running server instead of spawning a new process, eliminating ~300ms of MCP boot overhead per edit.

**Session pre-population.** When you press `Cmd+I`, the CLI process is spawned immediately and a session file is pre-built with fake `Read` tool results containing the current file content. This puts the file in context without requiring an actual Read tool call, and an assistant prefill message primes the model to go straight to `edit_file` without explanatory text.

**Prompt cache warming.** The Anthropic API caches prompt prefixes — system prompt, tool definitions, and conversation history — so repeated edits process only the new instruction. When the estimated token count exceeds the caching threshold (4,096 for Haiku), a lightweight pre-warm message is sent to the CLI while the user types their prompt. By the time the real instruction is submitted, the cache is hot and the API skips reprocessing the prefix.

**All edits go through VS Code.** File modifications use the `WorkspaceEdit` API via an IPC server, keeping edits in the undo stack and integrated with the editor. The diff between before/after text (via the `diff` library) determines which lines changed, driving both the focus scroll and the post-edit dimming effect.
