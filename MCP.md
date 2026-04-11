# Plan: MCP server with IPC bridge for VS Code edits

## Context

The CLI inline agent currently uses Claude Code's built-in Edit tool which:
1. Only supports one `old_string → new_string` replacement per call (multiple changes = multiple API round trips)
2. Writes directly to disk — the extension has to `revert` the document to pick up changes, losing VS Code undo history

An MCP server with IPC back to the extension solves both:
- **Multi-edit tool**: accepts an array of edits in one call → one API round trip
- **VS Code-native edits**: applies changes via `vscode.WorkspaceEdit` → proper undo/redo, dirty state

We keep the pre-created session with fake Read tool results (Claude is trained on this pattern).

## Architecture

```
VS Code Extension Host Process
│
├── On activation:
│   ├── Creates Unix domain socket at /tmp/codespark-<pid>.sock
│   ├── Listens for IPC connections
│   └── Writes MCP config JSON to temp file
│
├── MCP Server (stdio child process, started once on activation)
│   ├── Connects to Unix socket on startup
│   ├── Exposes tool: edit_file (multi-edit)
│   └── On tool call → sends edit request over socket → waits for response → returns to CLI
│
└── Claude CLI (per-invocation child process)
    ├── --mcp-config <temp-config-path>
    ├── --resume <session-id> (pre-populated with Read results)
    └── Calls mcp__codespark__edit_file → MCP server → IPC → extension → WorkspaceEdit
```

## IPC Protocol

Simple JSON-line protocol over Unix domain socket:

**Request (MCP server → extension):**
```json
{
  "id": "req_1",
  "type": "edit_file",
  "file_path": "/abs/path/to/file.ts",
  "edits": [
    { "old_string": "foo", "new_string": "bar" },
    { "old_string": "import { A }", "new_string": "import { A, B }" }
  ]
}
```

**Response (extension → MCP server):**
```json
{ "id": "req_1", "success": true, "message": "Applied 2 edit(s)" }
```
or
```json
{ "id": "req_1", "success": false, "error": "old_string not found in file" }
```

## Implementation

### 1. New file: `src/mcp-server.ts` (standalone Node.js script)

Bundled separately by esbuild as `out/mcp-server.js`. Runs as a stdio MCP server:

- Uses `@modelcontextprotocol/sdk` for the MCP protocol (stdio transport)
- Reads `CODESPARK_SOCKET` env var to find the Unix socket
- Connects to the socket on startup
- Registers one tool: `edit_file` with `file_path` + `edits[]` (array of `old_string`/`new_string`)
- Tool description should explain that edits are applied as `TextEdit` replacements: all ranges are computed against the original document text before any replacements, so edits don't affect each other's positions — the model doesn't need to account for offset shifts
- On tool call: sends JSON request over socket, waits for JSON response, returns result to CLI

### 2. New file: `src/ipc-server.ts` (runs in extension host)

Manages the Unix domain socket and applies edits:

- `startIpcServer()` — creates socket, returns `{ socketPath, dispose }`
- On startup: clean up stale socket file if it exists (`unlinkSync` before `listen`) to handle prior crashes
- On connection: reads JSON lines, dispatches to handler
- Handler: reads file from VS Code document buffer, applies edits via `WorkspaceEdit`, responds with success/error
- If any single edit in a batch fails (e.g. `old_string` not found), fail the entire batch — do not apply partial edits
- Edit application logic:
  1. Find open document or open it via `vscode.workspace.openTextDocument`
  2. For each edit: find `old_string` in document text, compute range
  3. Validate all edits first, then apply all replacements as a single `WorkspaceEdit` (atomic, single undo step)

### 3. Update `src/extension.ts`

- On activation: call `startIpcServer()`, store disposable
- Write MCP config JSON to temp file (points to `out/mcp-server.js` with `CODESPARK_SOCKET` env)
- On deactivation: dispose IPC server, clean up temp files

### 4. Update `src/claude-code-inline.ts`

- `prepareInlineAgent` accepts MCP config path
- Add `--mcp-config <path>` to CLI spawn args
- Replace `--tools "Read,Edit,Write"` with `--tools "Read"` (Edit/Write come from MCP)
- Keep session pre-population with fake Read tool results (unchanged)
- Remove the `workbench.action.files.revert` call — edits now applied via WorkspaceEdit
- Detect `mcp__codespark__edit_file` tool calls in stream (instead of `Edit`/`Write`)

### 5. Update system prompt

Tell the model about the multi-edit tool:
```
Use the edit_file tool to make changes. You can pass multiple edits in a single call.
For example, updating an import AND changing code should be one edit_file call with
two entries in the edits array, not two separate calls.
```

### 6. Update `esbuild.mjs`

Add a second entry point for `src/mcp-server.ts` → `out/mcp-server.js` (separate bundle, not part of the extension bundle).

## Files to create/modify

- **New: `src/mcp-server.ts`** — standalone MCP stdio server with IPC client
- **New: `src/ipc-server.ts`** — Unix socket server + WorkspaceEdit handler
- **Modify: `src/extension.ts`** — start IPC server, write MCP config
- **Modify: `src/claude-code-inline.ts`** — add `--mcp-config`, update tool detection, remove revert
- **Modify: `src/invoker.ts`** — pass MCP config path through
- **Modify: `esbuild.mjs`** — add mcp-server entry point
- **Modify: `package.json`** — add `@modelcontextprotocol/sdk` dependency

## Verification

1. Activate extension, check output panel for "IPC server started" + socket path
2. Trigger Cmd+I, make a simple edit
3. Check logs:
   - `mcp__codespark__edit_file` tool call (not `Edit`)
   - IPC request/response logged
   - No `workbench.action.files.revert`
4. Verify: edit appears in editor, Cmd+Z undoes it (single undo step)
5. Test multi-edit: "add an import for useState and use it in the component"
   - Should be 1 tool call with 2 edits in the array
6. Test error case: edit with wrong `old_string` — should return error to CLI
