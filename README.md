<p align="center">
  <img src="./media/logo.png" alt="CodeSpark" width="340" />
</p>

<p align="center"><em>The inline agent for writing code — with a research sidekick</em></p>

> You don't need to own every keystroke — but you do need to own the expression of your intent. And that happens at the file level, where you're closest to the code — not from a project-wide prompt.

Project-level agents like Claude Code, Copilot Agent, and Cursor are powerful. They explore your repo, run commands, debug across files, and plan complex changes. They operate in dynamic context — long sessions where the agent drives most of the decisions.

When it's time to actually write code, you want something different. Short sessions. Fast momentum. Full ownership of every change. You want to stay in your editor, point at the code, and say what needs to happen.

![CodeSpark in action](./media/screenshot.png)

## Project context

CodeSpark reads your `CLAUDE.md` and `AGENT.md` files so it knows your project's patterns and conventions. The edits it makes aren't generic — they match how _you_ write code in _this_ project.

You can link to files and directories from these files. Linked files are read into context so the agent understands their contents. Linked directories are expanded to show their filenames, giving the agent awareness of the project structure without loading every file.

These same files also improve your project-level agents — giving them better guidance for planning refactors, suggesting implementation approaches, and understanding how your codebase works.

## Research agent

CodeSpark includes a research agent that lives in the secondary sidebar (`CMD+Shift+I`). Use it to explore your codebase, search the web, and build understanding before you edit.

The research agent can read files, search with Brave, and fetch web pages — but it cannot edit anything. Every conversation automatically builds up context that the inline agent picks up on its next invocation. Ask a question in the research panel, and the next time you press `CMD+I`, the inline agent knows what you learned.

This means you can research an unfamiliar API, explore how a feature is implemented, or look up documentation — and then immediately make edits with that knowledge baked in.

To use web search, add a [Brave Search API key](https://brave.com/search/api/) in settings (`codeSpark.braveApiKey`).

## Getting started

1. Install the extension
2. Choose a provider in settings: **Copilot** (default, uses your GitHub Copilot subscription) or bring your own API key for Anthropic, OpenAI, Google, Mistral, Groq, xAI, OpenRouter, or Together
3. Add `CLAUDE.md` or `AGENT.md` files to guide CodeSpark. Place one in your project root for general conventions, and additional ones in subdirectories to describe the patterns, dependencies, and guidelines specific to each domain of your codebase
4. Open a file, press `CMD+I`, type an instruction — the edit lands directly in your file
5. Press `CMD+Shift+I` to open the research agent when you need to explore before editing

## Under the hood

CodeSpark uses a real agent harness powered by [pi.dev](https://pi.dev), configured with deterministic context and awareness of where your cursor is. Most edits are fast, single-turn file-scoped changes — but when the task demands it, the agent can read additional files and go as wide as it needs, just like a traditional agent. The difference is that it always stays within its bounds: working with the code of the project, never running commands or reaching outside it.

## Default models per provider

| Provider   | Default Model                               |
| ---------- | ------------------------------------------- |
| copilot    | `claude-haiku-4.5`                          |
| anthropic  | `claude-haiku-4-5-20251001`                 |
| openai     | `gpt-4.1-mini`                              |
| google     | `gemini-2.5-flash`                          |
| openrouter | `anthropic/claude-haiku-4-5-20251001`       |
| groq       | `llama-4-scout-17b-16e-instruct`            |
| xai        | `grok-3-mini`                               |
| mistral    | `mistral-medium-latest`                     |
| together   | `meta-llama/Llama-4-Scout-17B-16E-Instruct` |
