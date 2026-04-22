import * as childProcess from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import { buildAssistantSystemPrompt } from "./prompts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssistantQueryHandle {
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

export function createAssistantQuery(
  prompt: string,
  cwd: string,
  log: vscode.OutputChannel,
  mcpConfigPath?: string,
  resumeSessionId?: string,
): AssistantQueryHandle {
  log.appendLine(
    `[claude-code-assistant] Creating query (resume: ${resumeSessionId ?? "none"}) — ${prompt.slice(0, 100)}`,
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
    "--disallowedTools",
    "mcp__codespark__edit_file,mcp__codespark__write_file",
    "--system-prompt",
    buildAssistantSystemPrompt(cwd),
  ];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const proc = childProcess.spawn("claude", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.on("error", (err) => {
    log.appendLine(`[claude-code-assistant] Process error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    log.appendLine(
      `[claude-code-assistant] Process exited (code=${code}, signal=${signal}, pid=${proc.pid})`,
    );
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.appendLine(`[claude-code-assistant:stderr] ${chunk.toString().trim()}`);
  });

  proc.stdout?.on("data", () => {
    if (!stdoutSeen) {
      stdoutSeen = true;
      log.appendLine(`[claude-code-assistant] First stdout data received`);
    }
  });

  let stdoutSeen = false;

  function sendMessage(text: string) {
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    log.appendLine(
      `[claude-code-assistant] Sending message to stdin: ${msg.slice(0, 100)}`,
    );
    const ok = proc.stdin?.write(msg + "\n");
    log.appendLine(
      `[claude-code-assistant] stdin.write ok=${ok}, pid=${proc.pid}`,
    );
  }

  // Send initial prompt via stdin
  sendMessage(prompt);

  return { process: proc, sendMessage };
}

// ---------------------------------------------------------------------------
// Iterate NDJSON messages and yield webview events
// ---------------------------------------------------------------------------

export async function* iterateAssistantEvents(
  handle: AssistantQueryHandle,
  log: vscode.OutputChannel,
): AsyncGenerator<WebviewEvent> {
  let toolIdCounter = 0;
  const pendingTools = new Map<number, { tool: string; toolId: number; toolUseId?: string }>();
  /** Map from tool_use_id → our internal toolId, for matching tool results */
  const toolUseIdMap = new Map<string, { tool: string; toolId: number }>();
  let lastAssistantText = "";

  // With --include-partial-messages, multiple assistant messages arrive per turn;
  // only the last one has accurate output_tokens, so we defer emitting until the
  // turn is complete (next message_start or result).
  //
  // We also compute deltas: input_tokens from the API is cumulative (full context),
  // so we subtract the previous turn's input to get "added input". output_tokens
  // is already per-turn, so we emit it as-is.
  let lastInput = 0;
  let pendingUsage: {
    rawInput: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } | null = null;

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
          // Emit usage delta from the previous turn before starting a new one
          if (pendingUsage) {
            const addedInput = pendingUsage.rawInput - lastInput;
            lastInput = pendingUsage.rawInput;
            yield {
              type: "usage",
              source: "assistant" as const,
              inputTokens: addedInput,
              outputTokens: pendingUsage.outputTokens,
              cacheReadInputTokens: pendingUsage.cacheReadInputTokens,
              cacheCreationInputTokens: pendingUsage.cacheCreationInputTokens,
            };
            pendingUsage = null;
          }
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

        // message_delta arrives at end of streaming with final output_tokens
        if (evt?.type === "message_delta" && evt.usage) {
          if (pendingUsage && typeof evt.usage.output_tokens === "number") {
            pendingUsage.outputTokens = evt.usage.output_tokens;
          }
        }
      }

      if (msg.type === "assistant") {
        // Don't flush pending tools here — the assistant message arrives BEFORE
        // tools execute. Flushing now would emit premature tool-end events,
        // causing IPC edit highlighting to be skipped (editedLines still empty).
        // Tools are properly ended by tool_result handling (user message) and
        // safety-flushed at the result message and end-of-stream.

        const usage = msg.message?.usage;
        if (usage) {
          pendingUsage = {
            rawInput: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
            outputTokens: usage.output_tokens || 0,
            cacheReadInputTokens: usage.cache_read_input_tokens || 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          };
        }

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
                `[claude-code-assistant:tool-error] ${pending.tool}: ${description ?? "unknown error"}`,
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
        // Emit usage delta from the final turn
        if (pendingUsage) {
          const addedInput = pendingUsage.rawInput - lastInput;
          lastInput = pendingUsage.rawInput;
          yield {
            type: "usage",
            source: "assistant" as const,
            inputTokens: addedInput,
            outputTokens: pendingUsage.outputTokens,
            cacheReadInputTokens: pendingUsage.cacheReadInputTokens,
            cacheCreationInputTokens: pendingUsage.cacheCreationInputTokens,
          };
          pendingUsage = null;
        }
        yield* flushPendingTools(pendingTools, toolUseIdMap);

        const sdkSessionId = msg.session_id ?? "";
        handle.sdkSessionId = sdkSessionId;
        if (msg.subtype === "success") {
          const resultText = msg.result ?? lastAssistantText;
          log.appendLine(
            `[claude-code-assistant] Query complete (${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(4)})`,
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
          log.appendLine(`[claude-code-assistant] Query error: ${errors}`);
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
    log.appendLine(`[claude-code-assistant] Iteration error: ${errMsg}`);
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
