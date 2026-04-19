<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="240" />
</p>

<p align="center"><em>A coding agent where you still code</em></p>

![CodeSpark in action](./media/screenshot.png)

## Getting started

1. Install and authenticate the [Claude Code CLI](https://code.claude.com/docs/en/quickstart)
2. Install the CodeSpark extension: [Install in VS Code](https://marketplace.visualstudio.com/items?itemName=codespark.codespark-agent)

## The tools

### Assistant agent (`Cmd+Shift+I` / `Ctrl+Shift+I`)

Your thinking partner. Powered by Claude Code CLI running default models. It can read files, grep through your codebase, search the web, and fetch documentation. It helps you understand and break down the work into guided steps.

**Dynamic context:**

- Searches the codebase and the web
- Use `Cmd+Shift+I` / `Ctrl+Shift+I` from a file and it is added as context
- Generates a breakdown of steps you can focus

### Inline agent (`Cmd+I` / `Ctrl+I`)

Code with natural language. Powered by Claude Code CLI running Haiku, optimized for speed. When the task demands it, it reads and writes additional files — but it always stays within the code, never running commands or reaching outside the project.

**Deterministic context:**

- The current file content and focus area
- The closest `CLAUDE.md` in the directory hierarchy
- Any files and directories linked from those `CLAUDE.md` files
- The latest assistant summary and breakdown

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
