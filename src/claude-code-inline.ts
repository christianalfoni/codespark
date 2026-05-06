import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";

import { InlineEditResult, Usage } from "./types";
import { IpcServer } from "./ipc-server";
import { buildSystemPrompt } from "./prompts";
import { spawnClaude } from "./claude-cli";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface PreparedInlineEdit {
  proc: childProcess.ChildProcess;
  rl: readline.Interface;
  sessionFile: string;
  filePath: string;
  absFilePath: string;
}

export interface PrepareContext {
  fileContent: string;
  filePath: string;
  instructionContent: string | undefined;
  referenceFiles: { path: string; content: string }[];
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Pre-spawns the CLI and warms the prompt cache for a file.
 * Call this when a breakdown step is selected so the agent is ready
 * when the user clicks "Apply".
 */
export async function prepareInlineEdit(
  ctx: PrepareContext,
  log: vscode.OutputChannel,
  mcpConfigPath: string,
): Promise<PreparedInlineEdit> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    throw new Error("No workspace folder open");
  }

  const t0 = Date.now();
  const systemPrompt = buildSystemPrompt(ctx.instructionContent);

  // Build session with fake Read results + assistant prefill
  const sessionId = crypto.randomUUID();
  const encodedCwd = encodeCwdPath(workspaceFolder);
  const sessionDir = path.join(os.homedir(), ".claude", "projects", encodedCwd);
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);

  const absFilePath = path.resolve(workspaceFolder, ctx.filePath);
  const files: SessionFile[] = [
    { absPath: absFilePath, content: ctx.fileContent },
  ];
  for (const ref of ctx.referenceFiles) {
    files.push({
      absPath: path.resolve(workspaceFolder, ref.path),
      content: ref.content,
    });
  }

  const sessionContent = buildSessionJSONL(sessionId, workspaceFolder, files);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(sessionFile, sessionContent);
  log.appendLine(
    `[cli-inline:timing] Session prep: ${Date.now() - t0}ms (${files.length} file(s))`,
  );

  const tSpawn = Date.now();
  const env = { ...process.env, MAX_THINKING_TOKENS: "0" };

  const claude = spawnClaude({
    args: [
      "--model",
      "claude-haiku-4-5-20251001",
      "--tools",
      "Read,Glob,Grep",
      "--resume",
      sessionId,
    ],
    cwd: workspaceFolder,
    log,
    env,
    logPrefix: "cli-inline",
    systemPrompt,
    mcpConfigPath,
    onExit() {
      fs.promises.unlink(sessionFile).catch(() => {});
    },
  });

  log.appendLine(`[cli-inline:timing] Spawn: ${Date.now() - tSpawn}ms`);

  return {
    proc: claude.proc,
    rl: claude.rl,
    sessionFile,
    filePath: ctx.filePath,
    absFilePath,
  };
}

/**
 * Abort a prepared agent that was never executed.
 */
export function abortPreparedEdit(prepared: PreparedInlineEdit): void {
  prepared.proc.stdin?.end();
  prepared.proc.kill();
  prepared.rl.close();
  fs.promises.unlink(prepared.sessionFile).catch(() => {});
}

/**
 * Execute an already-prepared agent with a specific instruction.
 */
export async function executeInlineEdit(
  prepared: PreparedInlineEdit,
  instruction: string,
  log: vscode.OutputChannel,
  ipcServer: IpcServer,
  onStatus?: (text: string) => void,
): Promise<InlineEditResult> {
  const { proc, rl, filePath, absFilePath } = prepared;

  // Restrict IPC edits to this file only
  ipcServer.allowedEditFile = absFilePath;

  // Send instruction
  const userInstruction = `Apply the following changes to ${filePath}:\n\n${instruction}`;
  const inputMsg = JSON.stringify({
    type: "user",
    message: { role: "user", content: userInstruction },
  });
  proc.stdin!.write(inputMsg + "\n");

  const tSend = Date.now();
  log.appendLine(`[cli-inline] File: ${filePath}`);
  log.appendLine(`[cli-inline:prompt] ${instruction.slice(0, 200)}`);
  onStatus?.("Thinking...");

  let hasEdits = false;
  let editToolSeen = false;
  let ttftLogged = false;
  const toolsInFlight = new Map<string, { name: string; start: number }>();
  const activeToolBlocks = new Map<number, { name: string; json: string }>();
  let textResponseContent = "";
  let resultUsage: Usage | null = null;
  let lastApiCallOutput = 0; // last message_delta output — for context window size
  let totalOutputTokens = 0; // result.usage.output_tokens — accurate total across all API calls
  const editedLines: Array<{ startLine: number; endLine: number }> = [];

  let resolveOnDone: (() => void) | undefined;
  let rejectOnDone: ((err: Error) => void) | undefined;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveOnDone = resolve;
    rejectOnDone = reject;
  });

  // Resolves as soon as an edit is applied to the target file
  let resolveOnEdit: (() => void) | undefined;
  const editPromise = new Promise<void>((resolve) => {
    resolveOnEdit = resolve;
  });

  // Listen for edits applied via IPC
  const ipcEditSub = ipcServer.onEdit((editFilePath, _count, editedRanges) => {
    hasEdits = true;
    if (editFilePath === absFilePath) {
      editedLines.push(...editedRanges);
      resolveOnEdit?.();
    }
  });

  (async () => {
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        const ms = Date.now() - tSend;

        if (msg.type === "stream_event") {
          const evt = msg.event;

          if (evt?.type === "message_start") {
            const u = evt.message?.usage;
            if (u) {
              resultUsage = {
                inputTokens: u.input_tokens || 0,
                cacheReadInputTokens: u.cache_read_input_tokens || 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
                contextOutputTokens: 0,
                outputTokens: 0,
              };
            }
          }

          if (evt?.type === "message_delta") {
            if (evt.usage?.output_tokens) {
              lastApiCallOutput = evt.usage.output_tokens;
            }
          }

          if (evt?.type === "content_block_delta" && !ttftLogged) {
            ttftLogged = true;
            log.appendLine(`[cli-inline:timing] Time To First Token: ${ms}ms`);
          }

          if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "tool_use") {
              const toolName = evt.content_block.name ?? "unknown";
              const toolUseId = evt.content_block.id;
              if (typeof toolUseId === "string") {
                toolsInFlight.set(toolUseId, {
                  name: toolName,
                  start: Date.now(),
                });
              }

              if (typeof evt.index === "number") {
                activeToolBlocks.set(evt.index, { name: toolName, json: "" });
              }

              if (toolName === "mcp__codespark__edit_file") {
                editToolSeen = true;
              }

              onStatus?.(mapToolStatus(toolName));
            } else if (evt.content_block?.type === "text") {
              onStatus?.("Thinking...");
            }
          }

          if (
            evt?.type === "content_block_delta" &&
            evt.delta?.type === "text_delta"
          ) {
            textResponseContent += evt.delta.text ?? "";
          }

          if (
            evt?.type === "content_block_delta" &&
            evt.delta?.type === "input_json_delta"
          ) {
            const block = activeToolBlocks.get(evt.index);
            if (block && typeof evt.delta.partial_json === "string") {
              block.json += evt.delta.partial_json;
            }
          }

          if (evt?.type === "content_block_stop") {
            const block = activeToolBlocks.get(evt.index);
            if (block) {
              activeToolBlocks.delete(evt.index);
              let input: unknown;
              try {
                input = JSON.parse(block.json || "{}");
              } catch {
                input = undefined;
              }
              onStatus?.(describeTool(block.name, input));
            }
          }
        }

        // Tool result logging
        if (msg.type === "user") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type !== "tool_result") continue;
              const id = block.tool_use_id;
              const pending =
                typeof id === "string" ? toolsInFlight.get(id) : undefined;
              if (!pending) continue;
              toolsInFlight.delete(id);
              const status = block.is_error ? "error" : "ok";
              log.appendLine(
                `[cli-inline:tool] ${pending.name}: ${status} ${Date.now() - pending.start}ms`,
              );
            }
          }
        }

        if (msg.type === "result") {
          if (msg.subtype === "success") {
            if (!editToolSeen && textResponseContent.trim()) {
              log.appendLine(
                `[cli-inline:no-edit] LLM responded with text instead of edits: ${textResponseContent.trim()}`,
              );
            }
            totalOutputTokens = msg.usage?.output_tokens ?? 0;
            log.appendLine(
              `[cli-inline] Done (${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(4) ?? "?"})`,
            );
            if (resultUsage) {
              log.appendLine(
                `[cli-inline:tokens] in=${resultUsage.inputTokens}, cr=${resultUsage.cacheReadInputTokens}, cc=${resultUsage.cacheCreationInputTokens}, out=${totalOutputTokens} (ctx_out=${lastApiCallOutput})`,
              );
            }
          } else {
            const errors = msg.errors?.join("; ") ?? "Unknown error";
            log.appendLine(`[cli-inline] Error: ${errors}`);
            rejectOnDone?.(new Error(errors));
            return;
          }

          proc.stdin?.end();
          resolveOnDone?.();
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.appendLine(`[cli-inline] Stream error: ${errMsg}`);
      rejectOnDone?.(new Error(errMsg));
    }
  })();

  proc.on("error", (err) => {
    log.appendLine(`[cli-inline] Process error: ${err.message}`);
    rejectOnDone?.(err);
  });

  // Always wait for the result message so we can capture accurate cumulative
  // token counts from result.usage. The edit is applied by the MCP server
  // independently, so the user sees the change in the editor before this returns.
  try {
    await donePromise;
  } finally {
    ipcEditSub.dispose();
    ipcServer.allowedEditFile = null;
  }

  const latencyMs = Date.now() - tSend;
  log.appendLine(`[cli-inline:timing] Total (user-perceived): ${latencyMs}ms`);

  return {
    hasEdits,
    editedLines,
    textResponse:
      !editToolSeen && textResponseContent.trim()
        ? textResponseContent.trim()
        : undefined,
    latencyMs,
    // TODO: Fix the typing here
    // @ts-ignore
    inputTokens: resultUsage?.inputTokens ?? 0,
    outputTokens: totalOutputTokens,
    contextOutputTokens: lastApiCallOutput,
    // @ts-ignore
    cacheReadInputTokens: resultUsage?.cacheReadInputTokens ?? 0,
    // @ts-ignore
    cacheCreationInputTokens: resultUsage?.cacheCreationInputTokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapToolStatus(name: string): string {
  if (name === "Read") return "Reading...";
  if (name === "mcp__codespark__edit_file") return "Editing...";
  if (name === "Bash") return "Running...";
  if (name === "Grep") return "Searching...";
  if (name === "Glob") return "Finding...";
  return `${name}...`;
}

function describeTool(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;

  if (name === "Read") {
    const fp = str("file_path");
    return fp ? `Reading ${basename(fp)}` : mapToolStatus(name);
  }
  if (name === "mcp__codespark__edit_file") {
    const fp = str("file_path");
    return fp ? `Editing ${basename(fp)}` : mapToolStatus(name);
  }
  if (name === "Grep") {
    const pattern = str("pattern");
    return pattern
      ? `Grepping "${truncate(pattern, 40)}"`
      : mapToolStatus(name);
  }
  if (name === "Glob") {
    const pattern = str("pattern");
    return pattern ? `Finding ${truncate(pattern, 40)}` : mapToolStatus(name);
  }
  if (name === "Bash") {
    const cmd = str("command");
    return cmd ? `Running ${truncate(cmd, 40)}` : mapToolStatus(name);
  }
  return mapToolStatus(name);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatFileContentWithLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

function encodeCwdPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

interface SessionFile {
  absPath: string;
  content: string;
}

function buildSessionJSONL(
  sessionId: string,
  cwd: string,
  files: SessionFile[],
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  const version = "2.1.101";

  const baseFields = {
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId,
    version,
  };

  let prevUuid: string | null = null;

  // Fake Read tool results — inject file content into context
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const toolUseId = `toolu_preread_${i}`;
    const assistantUuid = crypto.randomUUID();
    const resultUuid = crypto.randomUUID();
    const numberedContent = formatFileContentWithLineNumbers(file.content);
    const numLines = file.content.split("\n").length;

    lines.push(
      JSON.stringify({
        parentUuid: prevUuid,
        isSidechain: false,
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          id: `msg_preread_${i}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: "Read",
              input: { file_path: file.absPath },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        uuid: assistantUuid,
        timestamp: now,
        ...baseFields,
      }),
    );

    lines.push(
      JSON.stringify({
        parentUuid: assistantUuid,
        isSidechain: false,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: toolUseId,
              type: "tool_result",
              content: numberedContent,
            },
          ],
        },
        uuid: resultUuid,
        timestamp: now,
        toolUseResult: {
          type: "text",
          file: {
            filePath: file.absPath,
            content: file.content,
            numLines,
            startLine: 1,
            totalLines: numLines,
          },
        },
        sourceToolAssistantUUID: assistantUuid,
        ...baseFields,
      }),
    );

    prevUuid = resultUuid;
  }

  // Assistant prefill — prime the model to go straight to tool use
  const prefillUuid = crypto.randomUUID();
  lines.push(
    JSON.stringify({
      parentUuid: prevUuid,
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: "msg_prefill",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I've read the file. I'll make assumptions where needed and apply the changes now.",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: prefillUuid,
      timestamp: now,
      ...baseFields,
    }),
  );

  return lines.join("\n") + "\n";
}
