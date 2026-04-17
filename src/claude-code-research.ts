import * as childProcess from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import { buildResearchSystemPrompt } from "./prompts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchQueryHandle {
  process: childProcess.ChildProcess;
  /** SDK session ID, available after the `result` message */
  sdkSessionId?: string;
  /** Send a follow-up message to the running process via stdin */
  sendMessage(text: string): void;
}

export type WebviewEvent =
  | { type: "turn-start" }
  | { type: "token"; text: string }
  | { type: "tool-start"; tool: string; toolId: number; description?: string }
  | { type: "tool-end"; tool: string; toolId: number; isError: boolean; description?: string }
  | {
      type: "done";
      resultText: string;
      sdkSessionId: string;
      numTurns?: number;
      totalCostUsd?: number;
    }
  | { type: "error"; text: string };

// ---------------------------------------------------------------------------
// Spawn claude CLI
// ---------------------------------------------------------------------------

export function createResearchQuery(
  prompt: string,
  cwd: string,
  log: vscode.OutputChannel,
  mcpConfigPath?: string,
  resumeSessionId?: string,
  allowEdits?: boolean,
): ResearchQueryHandle {
  log.appendLine(
    `[claude-code-research] Creating query (resume: ${resumeSessionId ?? "none"}) — ${prompt.slice(0, 100)}`,
  );

  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--strict-mcp-config",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    "--tools",
    "Read,Glob,Grep,WebSearch,WebFetch",
    ...(allowEdits
      ? []
      : [
          "--disallowedTools",
          "mcp__codespark__edit_file,mcp__codespark__write_file,mcp__codespark__move_file,mcp__codespark__delete_file",
        ]),
    "--system-prompt",
    buildResearchSystemPrompt(cwd),
  ];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const proc = childProcess.spawn("claude", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.on("error", (err) => {
    log.appendLine(`[claude-code-research] Process error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    log.appendLine(
      `[claude-code-research] Process exited (code=${code}, signal=${signal}, pid=${proc.pid})`,
    );
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.appendLine(`[claude-code-research:stderr] ${chunk.toString().trim()}`);
  });

  proc.stdout?.on("data", () => {
    if (!stdoutSeen) {
      stdoutSeen = true;
      log.appendLine(`[claude-code-research] First stdout data received`);
    }
  });

  let stdoutSeen = false;

  function sendMessage(text: string) {
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    log.appendLine(
      `[claude-code-research] Sending message to stdin: ${msg.slice(0, 100)}`,
    );
    const ok = proc.stdin?.write(msg + "\n");
    log.appendLine(
      `[claude-code-research] stdin.write ok=${ok}, pid=${proc.pid}`,
    );
  }

  // Send initial prompt via stdin
  sendMessage(prompt);

  return { process: proc, sendMessage };
}

// ---------------------------------------------------------------------------
// Iterate NDJSON messages and yield webview events
// ---------------------------------------------------------------------------

export async function* iterateResearchEvents(
  handle: ResearchQueryHandle,
  log: vscode.OutputChannel,
): AsyncGenerator<WebviewEvent> {
  let toolIdCounter = 0;
  const pendingTools = new Map<number, { tool: string; toolId: number; toolUseId?: string }>();
  /** Map from tool_use_id → our internal toolId, for matching tool results */
  const toolUseIdMap = new Map<string, { tool: string; toolId: number }>();
  let lastAssistantText = "";

  const rl = readline.createInterface({ input: handle.process.stdout! });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === "stream_event") {
        const evt = msg.event;

        if (evt?.type === "message_start") {
          yield { type: "turn-start" };
          lastAssistantText = "";
        }

        if (evt?.type === "content_block_start") {
          if (evt.content_block?.type === "tool_use") {
            const toolId = ++toolIdCounter;
            const toolName = evt.content_block.name ?? "unknown";
            const toolUseId = evt.content_block.id;
            pendingTools.set(evt.index, { tool: toolName, toolId, toolUseId });
            if (typeof toolUseId === "string") {
              toolUseIdMap.set(toolUseId, { tool: toolName, toolId });
            }
            yield {
              type: "tool-start",
              tool: toolName,
              toolId,
              description: undefined,
            };
          }
        }

        if (
          evt?.type === "content_block_delta" &&
          evt.delta?.type === "text_delta"
        ) {
          lastAssistantText += evt.delta.text;
          yield { type: "token", text: evt.delta.text };
        }
      }

      if (msg.type === "assistant") {
        // Don't flush pending tools here — the assistant message arrives BEFORE
        // tools execute. Flushing now would emit premature tool-end events,
        // causing IPC edit highlighting to be skipped (editedLines still empty).
        // Tools are properly ended by tool_result handling (user message) and
        // safety-flushed at the result message and end-of-stream.

        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              if (!lastAssistantText) {
                lastAssistantText = block.text;
              }
            }
          }
        }
      }

      // Handle tool results — detect errors and yield tool-end with error info
      if (msg.type === "user") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== "tool_result") continue;
            const id = block.tool_use_id;
            const pending = typeof id === "string" ? toolUseIdMap.get(id) : undefined;
            if (!pending) continue;
            toolUseIdMap.delete(id);

            const isError = !!block.is_error;
            let description: string | undefined;
            if (isError) {
              // Extract error text from the tool result content
              if (typeof block.content === "string") {
                description = block.content.slice(0, 200);
              } else if (Array.isArray(block.content)) {
                const textBlock = block.content.find((b: any) => b.type === "text");
                if (textBlock?.text) {
                  description = textBlock.text.slice(0, 200);
                }
              }
              log.appendLine(
                `[claude-code-research:tool-error] ${pending.tool}: ${description ?? "unknown error"}`,
              );
            }

            yield {
              type: "tool-end",
              tool: pending.tool,
              toolId: pending.toolId,
              isError,
              description,
            };
          }
        }
      }

      if (msg.type === "result") {
        yield* flushPendingTools(pendingTools, toolUseIdMap);

        const sdkSessionId = msg.session_id ?? "";
        handle.sdkSessionId = sdkSessionId;
        if (msg.subtype === "success") {
          const resultText = msg.result ?? lastAssistantText;
          log.appendLine(
            `[claude-code-research] Query complete (${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(4)})`,
          );
          yield {
            type: "done",
            resultText,
            sdkSessionId,
            numTurns: msg.num_turns,
            totalCostUsd: msg.total_cost_usd,
          };
        } else {
          const errors = msg.errors?.join("; ") ?? "Unknown error";
          log.appendLine(`[claude-code-research] Query error: ${errors}`);
          yield { type: "error", text: errors };
          yield {
            type: "done",
            resultText: lastAssistantText,
            sdkSessionId,
            numTurns: msg.num_turns,
            totalCostUsd: msg.total_cost_usd,
          };
        }

        // Reset for next turn
        lastAssistantText = "";
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[claude-code-research] Iteration error: ${errMsg}`);
    yield { type: "error", text: errMsg };
  }

  yield* flushPendingTools(pendingTools, toolUseIdMap);
}

function* flushPendingTools(
  pendingTools: Map<number, { tool: string; toolId: number; toolUseId?: string }>,
  toolUseIdMap: Map<string, { tool: string; toolId: number }>,
): Generator<WebviewEvent> {
  for (const [, pending] of pendingTools) {
    // Skip tools that were already resolved via tool_result handling
    if (pending.toolUseId && !toolUseIdMap.has(pending.toolUseId)) continue;

    yield {
      type: "tool-end",
      tool: pending.tool,
      toolId: pending.toolId,
      isError: false,
    };

    if (pending.toolUseId) {
      toolUseIdMap.delete(pending.toolUseId);
    }
  }
  pendingTools.clear();
}
