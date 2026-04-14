# CodeSpark - Development Guidelines

## Architecture Overview

This is a VS Code extension with two main agents:

- **Inline agent** (`claude-code-inline.ts`, `invoker.ts`): Fast, cursor-scoped edits via Claude Haiku
- **Research agent** (`research-agent.ts`, `research-view.ts`, `claude-code-research.ts`): Long-running chat agent for codebase exploration

Communication flows:

- Extension ↔ Claude CLI: spawned as child processes with `stream-json` I/O
- Extension ↔ Webview: `postMessage` / `onDidReceiveMessage`
- Extension ↔ MCP Server: IPC over Unix domain socket (`ipc-server.ts` → `mcp-server.ts`)

## Code Style & Structure

### Control Flow

- **Prefer early returns over nested conditionals**: When validating inputs or handling error cases, return early to avoid deep nesting and improve readability.

### Section Separators

Use dashed comment blocks to separate logical sections within a file:

```typescript
// ---------------------------------------------------------------------------
// Section Name
// ---------------------------------------------------------------------------
```

### Logging

All log output goes through `vscode.OutputChannel`. Use bracketed prefixes with module name and optional sub-category:

```typescript
log.appendLine(`[module-name] Simple message`);
log.appendLine(`[module-name:timing] First edit applied: ${ms}ms`);
log.appendLine(`[module-name:stderr] ${chunk.toString().trim()}`);
```

### Error Handling

Use this pattern for safe error message extraction:

```typescript
const msg = err instanceof Error ? err.message : String(err);
```

### Module-Level State

When a module needs mutable state tied to the extension lifecycle, use module-level variables with an explicit `init*()` function called from `extension.ts#activate`:

```typescript
let _workspaceState: vscode.Memento;

export function initMyModule(state: vscode.Memento): void {
  _workspaceState = state;
}
```

### Exports

- Use **named exports only** — no default exports anywhere in the codebase
- Use `export function` and `export class` directly (not `export default`)
- Re-export from barrel when exposing sub-module APIs: `export { fn } from "./submodule"`

## Naming Conventions

- Use camelCase for variables and functions
- Use PascalCase for classes and components
- Use UPPER_SNAKE_CASE for constants
- Use descriptive names that indicate purpose/type
- Prefix private class members with `_` (e.g. `_view`, `_log`, `_pendingFileContext`)

## Process Spawning

When spawning Claude CLI processes:

- Always use `stream-json` for both `--input-format` and `--output-format`
- Always include `--dangerously-skip-permissions` and `--disable-slash-commands`
- Use `--strict-mcp-config` when passing MCP config
- Read output via `readline.createInterface` on stdout, parsing NDJSON line by line
- Log stderr output with a `:stderr` sub-prefix
