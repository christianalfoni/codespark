# OpenCode as an alternative backend

Plan for adding OpenCode CLI alongside Claude Code CLI as a user-selectable engine.

## Verified findings (opencode 1.4.5)

Spun up `opencode serve --port 4096` against this workspace and exercised the API.

1. **One `opencode serve` hosts all workspaces.** `GET /doc` only publishes 9 "global" endpoints, but the full session/message/MCP/file surface is dynamically mounted per directory via the `?directory=<urlencoded>` query param (or `x-opencode-directory` header). Verified `POST /session?directory=...`, `GET /session/:id?directory=...`, `GET /session/:id/message?directory=...` all work. The SDK `@opencode-ai/sdk` (ships with the binary install) has typed bindings for all of them (`SessionCreate`, `SessionPromptAsync`, `SessionMessage`, `SessionFork`, `SessionAbort`, `McpAdd`, `McpConnect`, `FileRead`, `FindText`, `EventSubscribe`, …).
2. **SSE works.** `GET /global/event` emits `server.connected`, `session.created`, `session.updated`, `message.updated`, `message.part.updated`, plus `sync` replication events — each tagged with `{directory, project}` for scoping.
3. **Session injection works.** Import schema differs slightly from the published OpenAPI:
   - user msg: `model: {providerID, modelID}`
   - assistant msg: flat `modelID`/`providerID`/`mode`/`agent`/`path`/`cost`/`tokens`/`finish`

   Hand-built a session containing a synthetic assistant message with a `ToolPart` in `state.status:"completed"` carrying arbitrary `output` text, ran `opencode import seed.json`, and confirmed via `GET /session/:id/message` that the fabricated tool call round-trips intact. **This is the moral equivalent of Claude Code's JSONL prewarm trick** — the model sees `output` as a real prior tool result when the session is continued.
4. **Sessions persist in one SQLite DB** at `~/.local/share/opencode/opencode.db`, tables `session`/`message`/`part` + `project`. `message.data`/`part.data` are JSON blobs matching the exported shape. `opencode import` is the supported write path — avoid direct SQL.
5. **Serve lifecycle we own.** `opencode serve` doesn't daemonize. One port, one password via `OPENCODE_SERVER_PASSWORD`. Spawn once per extension activation.

One gotcha: the OpenAPI `/doc` is a lie of omission for client generators — to hit sessions you must pass the directory param the SDK adds automatically. Use the SDK, don't hand-roll from `/doc`.

## Architecture comparison

|                  | Claude Code                                     | OpenCode                                                      |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Engine           | `claude` CLI per request                        | `opencode serve` (long-lived process)                         |
| Transport        | stdio + stream-json NDJSON                      | HTTP + SSE (`@opencode-ai/sdk`)                               |
| Session store    | `~/.claude/projects/<cwd>/<id>.jsonl`           | `~/.local/share/opencode/opencode.db` (SQLite)                |
| Prewarm          | append JSONL before `--resume`                  | `opencode import seed.json` before `POST /session/:id/prompt_async` |
| MCP              | `--mcp-config mcp.json` per request             | `mcp.<name>` in `opencode.json`, loaded once by `serve`       |
| Tool permissions | `--tools` / `--disallowedTools` CLI flags       | `permission` block in `opencode.json`                         |

## Phase 1 — Backend abstraction (no behavior change)

Define `CliBackend` with two methods:
- `runInline(params) → AsyncIterable<InlineEvent>`
- `runResearch(params) → AsyncIterable<ResearchEvent>`

The event union is what the research path already emits: `turn-start`, `token`, `tool-start`, `tool-end`, `done`, `error`. Move current logic into `src/backends/claude-code-backend.ts`. Call sites in `invoker.ts` and `research-view.ts` talk to the interface only.

## Phase 2 — OpenCode backend (`src/backends/opencode-backend.ts`)

### Server lifecycle (`src/backends/opencode-server.ts`)
- On activation, spawn `opencode serve --port 0 --hostname 127.0.0.1` with a generated `OPENCODE_SERVER_PASSWORD`. Parse the `listening on http://127.0.0.1:<port>` line from stderr to discover the port.
- Instantiate `createOpencodeClient({ baseUrl, directory: workspaceFolder, headers: { authorization: "Basic " + ... } })`. The `directory` config auto-adds the query param to every request.
- Subscribe to `client.event.subscribe()` (SSE) once; fan events out to per-session listeners filtered on `payload.properties.sessionID`.
- On deactivate: `POST /global/dispose` then kill the child.

### Inline flow
1. Build a prewarm seed: one fake user message + one assistant message whose single `ToolPart` has `tool:"read"`, `state.status:"completed"`, `state.output:<file contents + CLAUDE.md>`. Mint fresh `ses_`/`msg_`/`prt_` IDs (format `<prefix>_<ulid>` — mint client-side).
2. `opencode import seed.json` via `child_process.exec` (shell out is safer than direct SQL).
3. `POST /session/:id/prompt_async` with the real user instruction + system prompt + agent.
4. Consume SSE: `message.part.updated` → emit `token` events for `TextPart.text` deltas; tool parts → `tool-start`/`tool-end` on state transitions; `session.idle` → `done`.
5. Pull cost/tokens from the final `AssistantMessage.tokens` / `cost` via `GET /session/:id/message`.

### Research flow
Same pattern minus prewarm. Multi-turn via another `POST /session/:id/prompt_async` against the same session id.

### MCP
Write/merge `opencode.json` at workspace root on activation with:
```json
{ "mcp": { "codespark": { "type": "remote", "url": "http://127.0.0.1:<mcp-port>/mcp", "enabled": true } } }
```
Existing `src/mcp-server.ts` stays untouched. Add `permission` rules to deny mutating tools for the research agent.

### Model selection
New setting `codespark.opencode.model` forwarded as the `model` param of `POST /session/:id/prompt_async` (shape `{providerID, modelID}`). Expose a picker populated by `GET /config/providers`.

## Phase 3 — User choice

- Setting `codespark.backend: "claude-code" | "opencode"` (default `"claude-code"`).
- Update `extension.ts:19` availability check to probe the selected backend (`claude --version` vs `opencode --version`). One-click command to switch.
- If OpenCode is picked but `opencode providers list` shows zero credentials, prompt the user to run `opencode providers login` in a VS Code terminal.

## Known risks / trade-offs

- **Schema drift.** Import shape is a variant of the public OpenAPI; lock to a specific `opencode` version range. On first run, export one real session and use its shape as a template so we adapt automatically if 1.5 changes the Zod.
- **Prewarm vs. cache.** Claude Code's `--resume` benefits from Anthropic-level prompt caching. OpenCode's cache behavior varies per provider. Accept that OpenCode inline may be slightly slower/more expensive than Claude inline; revisit if it matters.
- **Serve as a long-lived child process.** Different lifecycle from the current stateless-per-request Claude pattern. Adds crash-recovery and port-collision handling.
- **One vs many workspaces.** One `opencode serve` covers all VS Code windows of this extension. If two windows open the same workspace they'll see each other's sessions — scope sessions by creating a fresh `ses_` per inline edit; research sessions have explicit user-visible titles so overlap is fine.

## Suggested order

1. **Phase 2 spike** (~1 day): end-to-end round-trip in a throwaway script — spawn serve, create session, inject prewarm, stream SSE, read final tokens. Each piece verified individually; the spike proves the glue.
2. Phase 1 refactor.
3. Phase 2 proper.
4. Phase 3 UX.
