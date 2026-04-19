<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="240" />
</p>

<p align="center"><em>A coding agent where you still code</em></p>

![CodeSpark in action](./media/screenshot.png)

## Getting started

1. Install and authenticate the [Claude Code CLI](https://code.claude.com/docs/en/quickstart)
2. Install the CodeSpark extension: [Install in VS Code](https://marketplace.visualstudio.com/items?itemName=codespark.codespark-agent)

## How it works

### Assistant (`Cmd+Shift+I` / `Ctrl+Shift+I`)

Your thinking partner. Lives in the sidebar. Powered by Claude Code CLI running default models. It can read files, grep through your codebase, search the web, and fetch documentation. It helps you understand code and break down work into guided steps.

- Use `Cmd+Shift+I` / `Ctrl+Shift+I` from a file to open the assistant with that file as context
- Ask questions, explore approaches, and gather context
- When you want to implement something, the assistant creates a **breakdown** — a list of focused steps, each targeting a specific file

### Breakdown

The breakdown appears at the top of the assistant panel. Each step describes what needs to be done in a specific file, with hints and guidance rather than the full solution. Click a step to see its details and open the target file.

Each step has a ⚡ **apply button** that triggers a fast editing agent (Haiku) to implement that step automatically.

You can also make the changes yourself — the breakdown is there to guide you either way.

### Context

The assistant's findings are automatically shared with the editing agent. Additionally, `CLAUDE.md` files in your project hierarchy provide persistent instructions and can reference files that get included as context.
