<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="240" />
</p>

<p align="center"><em>Build with understanding — AI that helps you think, not just type</em></p>

> AI coding tools are great at generating code. But generated code you don't understand is a liability — you still have to review it, debug it, and maintain it over time. CodeSpark takes a different approach: instead of letting AI decide and execute on its own, it helps _you_ build the mental model, break down the work, and implement step by step. Every PR leaves you understanding the code you ship.

![CodeSpark in action](./media/screenshot.png)

## Getting started

1. Install and authenticate the [Claude Code CLI](https://code.claude.com/docs/en/quickstart)
2. Install the CodeSpark extension: [Install in VS Code](https://marketplace.visualstudio.com/items?itemName=codespark.codespark-agent)

## The workflow

CodeSpark is built around a natural cycle: **understand → break down → implement → review**. You do the coding — two agents support you along the way.

### 1. Understand

Open the assistant (`Cmd+Shift+I` / `Ctrl+Shift+I`) and explore. It reads files, greps through your codebase, searches the web, and fetches documentation. Ask it how something works, why a pattern exists, or what an API expects. Build your mental model before touching any code.

### 2. Break down

Ask the assistant to separate the work into concrete steps. It creates a **breakdown** — each step targeting a specific file with a list of considerations and hints, not a complete solution. Steps appear in the sidebar; click one to see its details and open the relevant file.

### 3. Implement

Work through steps one by one. You're the one coding — the inline agent (`Cmd+I` / `Ctrl+I`) supports you the way a calculator supports solving math problems. You decide what needs to change and why; it takes care of the mechanical parts. Because you're working step by step, you naturally review each change as it's made.

The inline agent knows about your breakdown: findings from the assistant are automatically shared as context, so it understands the bigger picture without you repeating yourself.

### 4. Review

When you're done, ask the assistant to review your changes against the breakdown. Catch mistakes, missed edge cases, or deviations while the context is still fresh.

Then start the next cycle.

## The tools

### Assistant agent (`Cmd+Shift+I` / `Ctrl+Shift+I`)

Your thinking partner. Powered by Claude Code CLI running default models. It can read files, grep through your codebase, search the web, and fetch documentation. It helps you understand and break down the work — without doing it for you.

The output is integrated with VS Code:

- File paths like `src/foo.ts:42` become clickable links that open the file at that line
- Fenced code blocks with `bash` render with a run button that executes the command in your terminal
- Code blocks annotated with a file path (e.g. ` ```ts file:src/foo.ts `) show the file name and an **Apply** button that sends the suggestion to the inline agent

### Inline agent (`Cmd+I` / `Ctrl+I`)

Your calculator. It doesn't code for you — it supports your coding. You stay at your cursor, describe what you want to change, and it handles the mechanical editing. Powered by Claude Code CLI running Haiku, optimized for speed. When the task demands it, it reads and writes additional files — but it always stays within the code, never running commands or reaching outside the project.

**Context it picks up automatically:**

- The current file content and cursor position
- The closest `CLAUDE.md` in the directory hierarchy
- Any files and directories linked from those `CLAUDE.md` files
- The latest assistant summary and breakdown

### CLAUDE.md

As you discover patterns and conventions in a codebase, write them down in `CLAUDE.md` files. Place one at the workspace root for project-wide instructions, and add more in subdirectories for domain-specific guidance. Both agents pick these up automatically.

This is the same `CLAUDE.md` convention used by Claude Code in the terminal. Instructions you write for CodeSpark also improve Claude Code CLI — you're building one set of knowledge that makes the AI better everywhere.

## Shortcuts

| Mac           | Windows / Linux | What it does                                         |
| ------------- | --------------- | ---------------------------------------------------- |
| `Cmd+I`       | `Ctrl+I`        | Open the inline agent — edit the file at your cursor |
| `Cmd+Shift+I` | `Ctrl+Shift+I`  | Open the assistant — explore and break down work     |

These shortcuts may conflict with other extensions (e.g. GitHub Copilot uses the same bindings). To rebind them, open the command palette and search for "Preferences: Open Keyboard Shortcuts (JSON)", then add your preferred bindings:

**Mac** — `Cmd+Shift+P` > "Preferences: Open Keyboard Shortcuts (JSON)"

```json
[
  { "key": "cmd+i", "command": "codeSpark.invoke", "when": "editorTextFocus" },
  { "key": "cmd+shift+i", "command": "codeSpark.openAssistant" }
]
```

**Windows / Linux** — `Ctrl+Shift+P` > "Preferences: Open Keyboard Shortcuts (JSON)"

```json
[
  { "key": "ctrl+i", "command": "codeSpark.invoke", "when": "editorTextFocus" },
  { "key": "ctrl+shift+i", "command": "codeSpark.openAssistant" }
]
```
