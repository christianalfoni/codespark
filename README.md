<p align="center">
  <img src="./media/title.png" alt="CodeSpark" width="400" />
</p>

<p align="center"><em>A coding agent where you still code</em></p>

## Getting started

1. Install and authenticate the [Claude Code CLI](https://code.claude.com/docs/en/quickstart)
2. Install the CodeSpark extension: [Install in VS Code](https://marketplace.visualstudio.com/items?itemName=codespark.codespark-agent)

On first activation, CodeSpark installs a global Claude Code command (`/apply-intents`) and a rule in `~/.claude/CLAUDE.md` that tells Claude Code never to edit files unless that command is explicitly run. No project files are modified.

## How it works

### Intent comments

You drive the work by writing intent comments directly in your code:

```ts
// MODIFY: extract this into a separate hook
// ADD: add error boundary around this component
// REMOVE: delete this deprecated helper
```

CodeSpark detects these across your entire workspace and highlights the keywords in the editor. The CodeSpark icon in the activity bar shows a badge with the total count. Click it to open the sidebar — each intent comment is listed with its file and line number. Click any entry to jump straight to it.

Use `Cmd+Shift+I` while the cursor is in an editor to toggle an intent comment on the current line. Each press cycles through `MODIFY → ADD → REMOVE → off`. The comment style matches the language (JS/TS uses `//`, Python uses `#`, JSX uses `{/* */}`, etc.) and inherits the indentation of the current line.

### Applying intents

When you're ready to apply your intent comments, run `/apply-intents` in Claude Code. Claude reads each comment in context, implements the change, removes the comment, and summarizes what was done.

Claude Code is configured (via the global `~/.claude/CLAUDE.md`) to never make edits outside of this command, so you stay in control of when changes happen.

## Why this approach

Coding is not about the characters you type. It is about how you choose to solve a problem — where you put the code, what it represents, how the pieces relate, which dependencies you reach for. Those decisions are the work. The keystrokes are just how you record them.

AI is genuinely useful in two situations: when you have a clear solution and just want to reduce the mechanical effort of writing it out, and when you don't have a clear solution and need help gathering context, exploring options, or thinking it through. What it should never do is make you stop thinking.

**The inline prompt problem.** The agent edits that one spot without knowing what else you're planning. Every edit is locally plausible but at risk of being globally wrong. And beyond correctness, there's the rhythm: you highlight, you wait, you review, you accept or reject, then find your place again. That constant stop-start works against the flow that good coding depends on — the natural pace of navigating a codebase and typing what you mean.

**The project prompt problem.** Handing the whole task to an agent — "implement this feature," "fix this bug" — has the opposite failure. The agent gets broad context but you get broad disconnection. You stop navigating your own codebase. You stop building the breakdown in your head: which files are affected, which abstractions are load-bearing, which changes cascade. The moment you hand it off entirely, the codebase starts to decay — and so does your understanding of the system you're responsible for.

**Intent comments keep you in the loop.** When you write an intent comment, you've already made a decision: this file, this location, this kind of change. You stay the author. The breakdown lives in your code, not in a prompt box. When you run `/apply-intents`, Claude sees everything at once — every file, every planned change, the full shape of what you're doing — and handles the mechanical execution. The understanding stays with you.

## Commands

| Command | Default shortcut | Description |
|---|---|---|
| `codeSpark.toggleIntentComment` | `Cmd+Shift+I` (when in editor) | Cycle `MODIFY → ADD → REMOVE → off` on the current line |
