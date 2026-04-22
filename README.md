<h1 align="center"><span style="color:#b16496">Code</span><span style="color:#ee81c3">Spark</span></h1>

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

## Breakdowns, not plans

Coding agents like Claude Code use **plan mode** — the AI creates a plan and then the AI implements it. You review the result. This works, but it comes with a cost: you stop building the mental model of your own codebase. You review diffs instead of writing code, and review is not the same as implementation. Reading a diff tells you _what_ changed. Writing the code teaches you _why_ it works, _how_ it connects, and _where_ the fragile parts are.

CodeSpark takes a different approach. The assistant creates a **breakdown** — a list of focused steps, each targeting a specific file — but _you_ implement them. The AI helps you understand the problem, explores the codebase, and generates the context you need to move fast. Then you write the code, or let the fast editing agent handle the mechanical parts while you stay in control.

This matters because **you are responsible for your codebase**. Your understanding of it is not a nice-to-have — it is what makes you effective. That understanding evolves through implementation, not through review. Every time you write code, you reinforce your mental model. Every time you skip implementation and only review, that model atrophies.

The breakdown makes this practical:

- **Context generation is fast** — the assistant reads files, searches the codebase, and synthesizes what you need to know.
- **Context is sticky** — because you implement the steps, what you learn stays with you. It becomes part of how you think about the codebase.
- **Token cost drops dramatically** — a breakdown is a fraction of the tokens an agent spends implementing a full plan. The AI does the exploration and guidance; you do the thinking and typing. The expensive part (iterating on implementation with an LLM) is replaced by the cheap part (you, writing code with guidance).
