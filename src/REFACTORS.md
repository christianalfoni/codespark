[user]:

I was thinking about creating better organization of the code. Could you do a little review and see if you can find some opportunities to make files simpler?

[assistant]:

I've gone through the codebase. Here's a focused review of where organization could be tightened — the goal is fewer mixed concerns per file, less duplication, and smaller surface areas to navigate.

## High-impact opportunities

### 1. Split [src/mcp-server.ts](vscode://file${workspaceFolder}/src/mcp-server.ts) (695 lines, multiple concerns)

This file mixes the HTTP/IPC plumbing with five distinct tool families. It's the biggest single file and the most natural to break up:

- `mcp-server/ipc-client.ts` — `connectIpc`, `sendIpcRequest`, `connectIpcWithRetry`
- `mcp-server/tools-fs.ts` — `read_file`, `list_directory`, `edit_file`, `write_file`
- `mcp-server/tools-breakdown.ts` — `write_breakdown`, `update_breakdown_step`
- `mcp-server/tools-git.ts` — `git_status`, `git_log`, `git_diff`, `git_blame`, plus `runGit` / `matchingRemote`
- `mcp-server/stacked-commits.ts` — `create_stacked_commits` + the long `createStackedCommits` helper (this is the largest single chunk in the file)
- `mcp-server/index.ts` — HTTP server + `registerTools(server)` orchestrator that just calls each module

The bundle entry stays the same (`out/mcp-server.js`) — only the source is reorganized.

### 2. Split [src/assistant-view.ts](vscode://file${workspaceFolder}/src/assistant-view.ts) (781 lines, the largest TS file)

`AssistantViewProvider` is doing eight things at once:

| Concern                  | Lines                                                                      | Could move to                    |
| ------------------------ | -------------------------------------------------------------------------- | -------------------------------- |
| Webview HTML / nonce     | `_getHtml`, `getNonce`                                                     | `assistant-view/html.ts`         |
| Terminal management      | `_getTerminal`, `_runInTerminal`, `_busyTerminals`, `_shellListenersReady` | `assistant-view/terminal.ts`     |
| Apply-step orchestration | `_handleApplyStep`, `_prepareFreshEdit`, `_prepareEdit` (~140 lines)       | `assistant-view/apply-step.ts`   |
| Session save/restore     | `_saveCurrentSession`, `_handleNewSession`, `_handleSwitchSession`         | could stay, but clearly grouped  |
| Breakdown post/persist   | `_postBreakdown`, `_persistBreakdown`, `_buildBreakdownContext`            | clearly grouped                  |
| Prompt event loop        | `_handlePrompt` + queue + `_eventLoopRunning`                              | clearly grouped                  |
| File-context handling    | `_pendingFileContext`, `_handleSendWithContext`, `_cursorSnippet`          | `assistant-view/file-context.ts` |

The class becomes a thin coordinator that delegates.

### 3. Deduplicate the "dim non-edited lines" effect

This block appears almost verbatim in both [src/invoker.ts:289-352](vscode://file${workspaceFolder}/src/invoker.ts:289) and [src/assistant-view.ts:325-378](vscode://file${workspaceFolder}/src/assistant-view.ts:325):

```typescript
const editedLineSet = new Set<number>();
for (const range of result.editedLines) { ... }
const dimType = vscode.window.createTextEditorDecorationType({ isWholeLine: true, opacity: "0.3" });
// build dimRanges, setDecorations, register save+undo listeners that cleanup()
```

Move to [src/editor-effects.ts](vscode://file${workspaceFolder}/src/editor-effects.ts) (already houses related effects):

```typescript
export function highlightEditedLines(
  editor: vscode.TextEditor,
  editedLines: Array<{ startLine: number; endLine: number }>,
  opts?: {
    restoreSelection?: vscode.Selection;
    restoreVisibleRange?: vscode.Range;
  },
): { dispose: () => void };
```

### 4. Deduplicate the Claude CLI spawn boilerplate

[src/claude-code-inline.ts](vscode://file${workspaceFolder}/src/claude-code-inline.ts) and [src/claude-code-assistant.ts](vscode://file${workspaceFolder}/src/claude-code-assistant.ts) both:

- Build `--print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --disable-slash-commands --strict-mcp-config ...` arg lists
- Spawn `claude` with `stdio: ["pipe", "pipe", "pipe"]`
- Wire up `proc.on("error")`, `proc.on("exit")`, `proc.stderr?.on("data")` with the same `[name:stderr]` logging pattern
- Create a `readline.createInterface({ input: proc.stdout! })`

Extract a small `src/claude-cli.ts` (or fold into a renamed spawn helper):

```typescript
export interface ClaudeProcess {
  proc: ChildProcess;
  rl: readline.Interface;
}
export function spawnClaude(opts: {
  cwd: string;
  args: string[]; // tool-specific args (--tools, --model, --resume, etc.)
  systemPrompt: string;
  mcpConfigPath?: string;
  env?: Record<string, string>;
  log: vscode.OutputChannel;
  logPrefix: string; // e.g. "cli-inline" or "claude-code-assistant"
}): ClaudeProcess;
```

That saves ~30 lines per call site and centralizes the flag list (currently easy to drift).

### 5. Deduplicate "gather CLAUDE.md + reference files"

Same logic appears in [src/invoker.ts:96-128](vscode://file${workspaceFolder}/src/invoker.ts:96) and [src/assistant-view.ts:407-432](vscode://file${workspaceFolder}/src/assistant-view.ts:407). Extract to [src/instructionDecorations.ts](vscode://file${workspaceFolder}/src/instructionDecorations.ts) (or a new `src/instructionContext.ts`):

```typescript
export async function gatherInstructionContext(
  editor: vscode.TextEditor,
  provider: InstructionFileDecorationProvider,
  opts?: { skipForInstructionFiles?: boolean },
): Promise<{
  instructionContent: string | undefined;
  referenceFiles: { path: string; content: string }[];
}>;
```

### 6. Tighten [src/promptInput.ts](vscode://file${workspaceFolder}/src/promptInput.ts)

The 8 command registrations (`submit`, `cancel`, `backspace`, `delete`, `cursorLeft/Right/Home/End`, `cursorUp/Down`) all follow the pattern `vscode.commands.registerCommand("codeSpark.inlinePrompt.X", handler)`. With:

```typescript
const cmds: vscode.Disposable[] = [];
function bind(name: string, handler: () => void) {
  cmds.push(
    vscode.commands.registerCommand(`codeSpark.inlinePrompt.${name}`, handler),
  );
}
```

…the disposable list and `cleanupCommands` collapse from ~50 lines to ~15. Also the 3 background decorations (`promptDeco`, `statusDeco`, `responseDeco`) are identically configured and could share one factory.

### 7. Split [src/assistant-agent.ts](vscode://file${workspaceFolder}/src/assistant-agent.ts) into two concerns

It currently mixes:

- **Persistent session store** (workspaceState-backed) — `_sessions`, `_activeSessionId`, `createSession`, `switchSession`, `updateSessionEntries`, `saveBreakdownSteps`, `appendAssistantContext`, etc.
- **Live process registry** — `_liveQueries`, `startAssistantQuery`, `abortLiveQuery`, `getLiveQuery`

Split into `src/assistant-sessions.ts` (store) and `src/assistant-live.ts` (process registry). The names of the imports also become more self-documenting at call sites.

### 8. Smaller cleanups

- [src/webview/useMessageHandling.ts](vscode://file${workspaceFolder}/src/webview/useMessageHandling.ts): the `zeroUsage` object literal is duplicated 3 times. Pull to a module-level `ZERO_USAGE` constant.
- [src/webview/App.tsx:412](vscode://file${workspaceFolder}/src/webview/App.tsx:412): the long literal "Create stacked commits…" prompt and the "Review the changes…" prompt are embedded in JSX. Move both to a `breakdownActions.ts` file, or to `prompts.ts` so all canned prompts live together.
- [src/ipc-server.ts](vscode://file${workspaceFolder}/src/ipc-server.ts): `handleConnectionData` takes 8 params (4 of which are listener Sets). Pass a single `{ listeners, getAllowedEditFile }` context object — easier to extend (you'll likely add more breakdown-style listeners later).
- The two stack `parseFenceLines`/`shouldTreatAsInnerOpener` algorithms in [src/webview/prepareForRender.ts](vscode://file${workspaceFolder}/src/webview/prepareForRender.ts) (`getFenceState` and `upgradeNestedFences`) walk the same fence list with nearly identical loops. They could share a single `walkFences(fences, callbacks)` traversal — but this one is risky to refactor since the test suite is large; only do it if you also want the simplification.

## Suggested priorities

If you only do a few:

1. **Split `mcp-server.ts`** — biggest, cleanest split, no behavior change risk.
2. **Extract `highlightEditedLines` and `gatherInstructionContext`** — kills the most duplication for the smallest cost.
3. **Extract `spawnClaude`** — once duplication is gone, divergence in CLI flags becomes immediately visible.
4. **Split `assistant-view.ts` apply-step + terminal + html** — shrinks the largest file by ~250 lines without touching its public surface.

Want me to put any of these into a breakdown?
