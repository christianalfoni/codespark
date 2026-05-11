<p align="center">
  <img src="./media/title.png" alt="CodeSpark" width="400" />
</p>

<p align="center"><em>A coding agent where you still code</em></p>

![CodeSpark in action](./media/screenshot.png)

## Getting started

1. Install and authenticate the [Claude Code CLI](https://code.claude.com/docs/en/quickstart)
2. Install the CodeSpark extension: [Install in VS Code](https://marketplace.visualstudio.com/items?itemName=codespark.codespark-agent)

## How it works

### Intent comments

You drive the work by writing intent comments directly in your code:

```ts
// MODIFY: extract this into a separate hook
// ADD: add error boundary around this component
// REMOVE: delete this deprecated helper
```

CodeSpark detects these across your entire workspace, highlights the keywords in the editor, and lists them in the sidebar. When you're ready, click the bolt button to send all intent comments to the assistant — it reads each one, navigates to the right file and line, and applies the changes. Files are saved automatically after each edit.

Use `Cmd+Shift+I` while the cursor is in an editor to toggle an intent comment on the current line. Each press cycles through `MODIFY → ADD → REMOVE → off`. The comment style matches the language (JS/TS uses `//`, Python uses `#`, JSX uses `{/* */}`, etc.) and inherits the indentation of the current line.

### Assistant

The assistant lives in the sidebar. Ask it questions, explore approaches, or have it look things up — it can read files, search your codebase, fetch documentation, and run git commands. It won't touch your code unless you trigger the bolt.

Open it with `Cmd+Shift+I` / `Ctrl+Shift+I` when not in an editor. If you have a file open, it opens with that file as context.

## Why this approach

The standard inline agent workflow has a hidden problem. You highlight some code, type a prompt, and the agent makes a change — but it has no idea what else you're planning. It works on that one spot in isolation, making local decisions without knowing that you're about to restructure three other files around it. The result is technically correct but contextually wrong: the agent optimizes for the prompt it was given, not for the system you're building.

Intent comments flip this around. Instead of prompting the agent from the outside and hoping it infers your intent, you state your intent directly in the code — at the exact locations where the changes will happen. When you trigger the bolt, the agent sees all of it at once: every file, every change you have planned, the full shape of what you're trying to do. It works from the inside out, with the context it actually needs.

But there's a deeper reason this matters. Every time you hand off a task to an agent without fully working through it yourself, you take on **cognitive debt**. You stop forming the mental model that comes from navigating your own code. You stop building the breakdown in your head — the sense of which files are affected, which abstractions are load-bearing, which changes cascade. That understanding is not a byproduct of writing code; it *is* writing code. The moment you outsource it, it starts to decay.

CodeSpark is designed to keep you in that loop. You write the intent comments — which means you've already thought through what needs to change and where. You stay the author. The agent handles the mechanical execution, but the understanding stays with you.

## Commands

CodeSpark registers the following commands (accessible via the Command Palette). You can bind them to keyboard shortcuts in your `keybindings.json`:

| Command | Default shortcut | Description |
|---|---|---|
| `codeSpark.openAssistant` | `Cmd+Shift+I` (when not in editor) | Open the assistant with the current file as context |
| `codeSpark.toggleIntentComment` | `Cmd+Shift+I` (when in editor) | Cycle `MODIFY → ADD → REMOVE → off` on the current line |
