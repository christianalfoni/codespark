# Streaming Edits POC — Learnings

We prototyped applying `edit_file` operations incrementally, as the model
streams the tool's JSON input, rather than waiting for the full tool call
to complete and going through the MCP round-trip.

The POC worked end-to-end. We reverted it — the gain didn't justify the
complexity it added to a path that already works. This doc captures what
we learned so a future attempt starts informed.

## Motivation

The inline agent's `edit_file` tool currently:

1. Model streams the tool-use block's JSON input (via `input_json_delta`)
2. On `content_block_stop`, Claude CLI invokes the MCP `edit_file` tool
3. MCP forwards the full batch over IPC, the extension applies all edits
   atomically against the original document text

Step 1 can take the majority of the user-perceived latency for multi-edit
calls — the user sees nothing until the last `new_string` has streamed.
Streaming would let each edit land as soon as its closing `}` parses.

## What we built

Three pieces:

1. **`streamingEditParser.ts`** — a tiny state machine fed partial JSON
   chunks. Tracked brace depth, handled string escapes, emitted each
   complete `{old_string, new_string}` object as it closed, plus the
   `file_path` once its string was complete.

2. **`IpcServer.beginStreamingEditCall(filePath)`** — returned a handle
   with `applyEdit(edit)` and `finish()`. Registered the call in a per-file
   FIFO of pending result promises.

3. **Inline agent wiring** — on `content_block_start` for
   `mcp__codespark__edit_file`, create a parser. Feed it each
   `input_json_delta`. Each parsed edit went through a serialized promise
   queue into `handle.applyEdit`. On `content_block_stop`, drain and
   `handle.finish()`.

The MCP `edit_file` handler, when it eventually fired, awaited the next
entry in the file's FIFO and forwarded that result to the socket — so the
streaming side did the work and the MCP side just reported it.

## What we learned

### 1. The race between streaming apply and the MCP call is real

First attempt used content-based dedup: record every successfully streamed
edit's `{old, new}` in a map with a TTL, then have the MCP handler filter
its batch against the map. Symptom: renaming `Counter` → `SuperCounter`
produced `SuperSuperCounter`.

Root cause: `recordStreamedEdit` was called *after* `await handleEditRequest`
resolved. The MCP call arrived during that await window. Dedup ran against
an empty map, both paths called `doc.getText()` before either write
committed, both saw `Counter`, both queued the same replacement. Two
applies. The fix was to record eagerly and unrecord on failure — but that
introduced its own edge case (streaming fails *after* MCP acked dedup
success → edit silently lost).

**Lesson:** any scheme where two independent code paths write to the same
document needs an explicit synchronization point, not content-based
reconciliation.

### 2. FIFO-of-promises per file path was much simpler than content dedup

Replacing the record/unrecord/consume machinery with
`Map<filePath, Array<Promise<IpcResponse>>>` eliminated:

- Content matching (fragile if the streamed JSON differs from MCP input)
- TTL + garbage collection
- Eager-record / unrecord-on-failure
- The race entirely — MCP awaits the same promise streaming resolves, so
  double-apply is physically impossible

Correlation by FIFO-per-file works because Claude CLI invokes tools in the
order their `tool_use` blocks completed — an ordering guarantee the older
content-dedup already implicitly relied on, just not named.

**Lesson:** if you reach for content matching as a correlation mechanism,
there's probably a simpler ordering invariant hiding in the system.

### 3. Atomicity semantics change, which bleeds into model behavior

The current `edit_file` contract says ranges are computed against
*original* text — so edits don't affect each other's positions. Streaming
applies sequentially against the mutating document. If the model emits
multiple edits whose `old_string`s overlap or whose context changes once
an earlier edit applies, later edits can fail with "not found" or
(worse) resolve to an unintended location.

In practice the model handled "old_string not found" gracefully — it
re-read the file and retried — but the semantics shift is real and
should be documented in the tool description if this ever ships.

**Lesson:** changing a tool's execution semantics without changing its
schema means the model is operating on stale assumptions. Fine for a POC,
worth prompt-documenting for production.

### 4. Edited-range highlights need aggregation, not per-edit emission

Naive implementation fired the `onEdit` listener per streamed edit with
the ranges from that single edit's diff. Symptom: only the first edit
highlighted; later edits didn't fade in.

Root cause: each edit's ranges were computed against the document state
at *that edit's moment*. When a later edit added or removed lines above
an earlier range, the earlier range's line numbers became stale relative
to the final document.

Fix: snapshot document text at the start of the streaming call, diff
initial-vs-final once in `finish()`, fire the listener a single time with
correct aggregate ranges. Works, but loses the "watch edits appear
progressively" effect — the decoration lands once at the end.

**Lesson:** line-number ranges captured mid-sequence don't survive later
edits. Either aggregate at the end (simple, correct, not progressive) or
track and shift ranges forward as each subsequent edit lands (complex,
preserves progressive UX).

### 5. The latency win is modest for single-edit calls

For a 1-edit `edit_file` call, streaming applied ~15ms after the closing
`}` parsed, MCP arrived ~860ms later. The user *did* see the file change
~860ms earlier than baseline. For multi-edit calls the gain compounds —
each edit lands as its JSON closes rather than all at the end.

But most inline-agent edit calls in our usage are 1–3 edits. The added
surface area (parser, FIFO, handle lifecycle, aggregate-at-finish range
handling, semantic shift from atomic to sequential) wasn't a good trade
for the typical case.

**Lesson:** measure edit-count distributions before committing to an
optimization that's priced per-edit. The `[ipc] edit_file: N edit(s)`
log we kept makes this easy to track.

### 6. Aborts need to resolve FIFO entries

If streaming registered a handle but `content_block_stop` never fired
(process killed, stream truncated), the MCP call would await the unresolved
promise forever. In the POC we accepted it because the MCP call wouldn't
arrive either if the process died. A production version would wire the
process `exit` handler to `finish()` any open handles with an error.

## A UX idea worth building around if this ships

The real appeal of streaming edits isn't the latency — it's the chance to
make the editor *perform* the refactor: scroll to each change, show it
land, pause so the user can register what happened, move on to the next.
A raw stream of as-fast-as-possible applies doesn't give that; it just
looks like the whole file blinked.

The shape would be a paced playback queue.

### Mechanics

A per-file dwell queue in the inline agent:

```
queue:     Array<ParsedEdit>
dwellMs:   ~600ms (tune by feel; 400–800ms is probably the range)
state:     idle | applying | dwelling
```

The parser pushes each parsed edit onto the queue. A driver loop:

1. Pop next edit. Scroll to its target (`revealLine` with `at: "center"`).
2. Apply it via `handle.applyEdit`.
3. Briefly highlight the edited region (reuse whatever decoration the
   post-edit fade already uses, or a dedicated "just-applied" flash).
4. `await sleep(dwellMs)`.
5. Loop.

The `content_block_stop` handler enqueues a "done" sentinel instead of
calling `handle.finish()` directly. The driver calls `finish()` only when
it dequeues the sentinel — so the MCP tool result is held until the
playback actually completes. Model waits ~N × dwellMs; for typical 1–3
edit calls that's under 2 seconds of paced animation.

### Two timing regimes

**Stream faster than dwell** (the interesting case — likely common for
small edits that model generates quickly):

```
t=0    edit 1 parses → apply, scroll, start 600ms dwell
t=100  edit 2 parses → queued
t=250  edit 3 parses → queued
t=300  stream ends   → "done" sentinel queued
t=600  dwell ends    → apply edit 2, scroll, start 600ms dwell
t=1200 dwell ends    → apply edit 3, scroll, start 600ms dwell
t=1800 dwell ends    → dequeue sentinel, call handle.finish()
```

The user sees a smooth sequence. The underlying stream finished at 300ms
but the playback is what they experience.

**Stream slower than dwell** (less common — large `new_string` content):

```
t=0    edit 1 parses → apply, scroll, start 600ms dwell
t=600  dwell ends, queue empty → state = idle
t=900  edit 2 parses → apply immediately (no dwell gating needed),
                        scroll, start 600ms dwell
...
```

Dwell only gates when there's back-pressure. An isolated edit that
arrives to an empty queue applies immediately.

### Interaction with existing code

- `ipc-server.ts` already has `handle.applyEdit` and `handle.finish()` —
  the paced driver lives in the inline agent and just schedules its calls
  to those. No new IPC machinery.
- The existing post-edit dim/fade decoration (`invoker.ts:442+`) fires on
  the cumulative listener call — still fine, happens once at `finish()`
  as today.
- Per-edit flash/highlight is new UI. Could be a single short-lived
  `createTextEditorDecorationType` with a background color, disposed
  after `dwellMs`.

### Open questions

- **Scope**: only the focused file, or animate across files? A rename
  that touches 5 files would be impressive to watch, but scroll-hopping
  the editor between files feels disorienting. Probably limit the
  animation to the focused file; edits to other files apply silently.
- **Abort path**: user types or clicks during playback → drain the queue
  without dwell (fast-forward) and then `finish()`. The model shouldn't
  see a failure for what's essentially a cosmetic preference.
- **Dwell tuning**: 600ms is a guess. Worth a quick A/B with real users.
  Likely varies by edit size — a one-character change wants less dwell
  than a 10-line block replacement.
- **What if an edit fails mid-queue**: show the error at that edit's
  location, stop the playback, report to the model. Matches the semantics
  we already have — failure halts the stream.
- **Pacing signals**: the dwell could be tied to the size of the change
  (bigger diff → longer dwell) rather than constant. A scripted "read
  speed" function. Probably overengineering for v1.

### Why this is the version worth shipping

The plain streaming POC we built was technically correct and modestly
faster, but visually identical to the batched path — all the edits land
in a single frame from the user's perspective. The paced version turns
the latency we can't hide (model generation time) into a feature: the
user watches the refactor happen instead of watching a spinner. That's
a real product difference, not a micro-optimization.

## What stays

- `[ipc] edit_file: N edit(s) on <path>` log, so we can observe edit-count
  distribution and know whether streaming would actually help.

## Files the POC touched (now reverted)

- `src/streamingEditParser.ts` (deleted)
- `src/streamingEditParser.test.ts` (deleted)
- `src/ipc-server.ts` (streaming additions removed, log kept)
- `src/claude-code-inline.ts` (restored to `HEAD`)
