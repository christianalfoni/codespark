import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { ResolvedContext, LLMResult } from "./types";
import { getResearchSummary } from "./research-agent";
import { IpcServer } from "./ipc-server";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code editor assistant. The user will show you a file and tell you what they want changed. Do NOT read the file — it has already been read into context.

To edit the current file, use the edit_file tool (NOT Edit or Write). You can pass multiple edits in a single call. For example, updating an import AND changing code should be one edit_file call with two entries in the edits array, not two separate calls.

Always call edit_file as the LAST tool call. Do all reads and other file edits first, then apply changes to the current file with edit_file.

If you need to modify other files (not the current one), use the Edit or Write tools for those.

Do not add code comments unless the user explicitly asks for them.

The user will indicate where they are looking in the file. Make edits in that area based on their instruction. You may make multiple edits if needed (e.g. updating imports alongside the main change).

Do not read files that are already in context. If the user's instruction references other files that would help you make better edits (e.g. types, interfaces, utilities, or related components), use the read tool to read them before editing.`;

const SYSTEM_PROMPT_CLAUDE_MD = `You are editing an instruction file (CLAUDE.md). These files provide instructions and context to AI code editors when working with files in this directory.

Good content includes:
- Project patterns and conventions (naming, structure, idioms)
- API usage patterns and preferred libraries
- Rules and constraints for code in this directory
- Key types, interfaces, or data structures to be aware of
- Common pitfalls or non-obvious behavior

Write in markdown format. Be concise and practical — write for an AI that already understands programming.

Use the edit tool to make changes.`;

function buildSystemPrompt(
  ctx: Pick<ResolvedContext, "isInstructionFile" | "instructionContent">,
): string {
  if (ctx.isInstructionFile) {
    return SYSTEM_PROMPT_CLAUDE_MD;
  }

  let prompt = SYSTEM_PROMPT;

  if (ctx.instructionContent) {
    prompt += `\n\n# CLAUDE.md\n\n${ctx.instructionContent}`;
  }

  const summary = getResearchSummary();
  if (summary) {
    prompt += `\n\n# Research Summary\n\n${summary}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Session pre-population — write fake Read tool results into a JSONL session
// ---------------------------------------------------------------------------

function encodeCwdPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function formatFileContentWithLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

interface SessionFile {
  absPath: string;
  content: string;
  numLines: number;
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

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const toolUseId = `toolu_preread_${i}`;
    const assistantUuid = crypto.randomUUID();
    const resultUuid = crypto.randomUUID();
    const numberedContent = formatFileContentWithLineNumbers(file.content);

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
            numLines: file.numLines,
            startLine: 1,
            totalLines: file.numLines,
          },
        },
        sourceToolAssistantUUID: assistantUuid,
        ...baseFields,
      }),
    );

    prevUuid = resultUuid;
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Prepared agent handle — CLI is spawned and booting, waiting for instruction
// ---------------------------------------------------------------------------

export interface PreparedInlineAgent {
  proc: childProcess.ChildProcess;
  sessionFile: string;
}

/**
 * Pre-spawns the CLI with --input-format stream-json so it boots while the
 * user types. The process waits for a JSON message on stdin (no timeout).
 */
export async function prepareInlineAgent(
  ctx: Pick<
    ResolvedContext,
    | "fileContent"
    | "filePath"
    | "referenceFiles"
    | "instructionContent"
    | "isInstructionFile"
  >,
  log: vscode.OutputChannel,
  mcpConfigPath: string,
): Promise<PreparedInlineAgent> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    throw new Error("No workspace folder open");
  }

  const t0 = Date.now();
  const systemPrompt = buildSystemPrompt(ctx);

  // Pre-populate session with fake Read tool results
  const sessionId = crypto.randomUUID();
  const encodedCwd = encodeCwdPath(workspaceFolder);
  const sessionDir = path.join(os.homedir(), ".claude", "projects", encodedCwd);
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);

  const absFilePath = path.resolve(workspaceFolder, ctx.filePath);
  const fileLines = ctx.fileContent.split("\n").length;

  const files: SessionFile[] = [
    { absPath: absFilePath, content: ctx.fileContent, numLines: fileLines },
  ];

  for (const ref of ctx.referenceFiles) {
    const refAbsPath = path.resolve(workspaceFolder, ref.path);
    files.push({
      absPath: refAbsPath,
      content: ref.content,
      numLines: ref.content.split("\n").length,
    });
  }

  const sessionContent = buildSessionJSONL(sessionId, workspaceFolder, files);

  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(sessionFile, sessionContent);
  const tSession = Date.now();
  log.appendLine(
    `[cli-inline:timing] Session prep: ${tSession - t0}ms (${files.length} file(s))`,
  );

  // Spawn CLI with stream-json input — no stdin timeout
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-haiku-4-5-20251001",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--tools",
    "Read,Edit,Write",
    "--system-prompt",
    systemPrompt,
    "--resume",
    sessionId,
  ];

  const env = { ...process.env, MAX_THINKING_TOKENS: "0" };

  const proc = childProcess.spawn("claude", args, {
    cwd: workspaceFolder,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.appendLine(`[cli-inline:stderr] ${chunk.toString().trim()}`);
  });

  // Clean up session file when process exits
  proc.on("exit", () => {
    fs.promises.unlink(sessionFile).catch(() => {});
  });

  log.appendLine(
    `[cli-inline] CLI spawned (stream-json), waiting for instruction...`,
  );

  return { proc, sessionFile };
}

/**
 * Abort a prepared agent that was never executed (e.g. user cancelled the prompt).
 */
export function abortInlineAgent(agent: PreparedInlineAgent): void {
  agent.proc.stdin?.end();
  agent.proc.kill("SIGTERM");
  fs.promises.unlink(agent.sessionFile).catch(() => {});
}

// ---------------------------------------------------------------------------
// Execute — send instruction to the prepared agent and wait for edits
// ---------------------------------------------------------------------------

export async function executeInlineAgent(
  agent: PreparedInlineAgent,
  ctx: ResolvedContext,
  log: vscode.OutputChannel,
  ipcServer: IpcServer,
  onAgentMode?: () => void,
): Promise<LLMResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!;
  const { proc } = agent;

  // Build user instruction
  const selectionPrefix = ctx.selection
    ? `\`\`\`\n${ctx.selection}\n\`\`\`\n\n`
    : "";
  const userInstruction = `I am currently looking at this area of the file ${ctx.filePath} (around line ${ctx.cursorLine}):\n\n\`\`\`\n${ctx.contextSnippet}\n\`\`\`\n\n${selectionPrefix}${ctx.instruction}`;

  const tSend = Date.now();
  log.appendLine(`[cli-inline] File: ${ctx.filePath}`);
  log.appendLine(`[cli-inline:prompt] ${ctx.instruction}`);

  // Send instruction as stream-json user message
  const inputMsg = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: userInstruction,
    },
  });
  proc.stdin!.write(inputMsg + "\n");
  proc.stdin!.end();

  // ---------------------------------------------------------------------------
  // Parse NDJSON stream
  // ---------------------------------------------------------------------------
  const rl = readline.createInterface({ input: proc.stdout! });

  let hasEdits = false;
  let editToolSeen = false;
  let firstToolSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;

  let resolveOnEdit: (() => void) | undefined;
  const editDonePromise = new Promise<void>((resolve) => {
    resolveOnEdit = resolve;
  });

  let resolveOnDone: (() => void) | undefined;
  let rejectOnDone: ((err: Error) => void) | undefined;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveOnDone = resolve;
    rejectOnDone = reject;
  });

  function markEditsApplied() {
    if (!hasEdits) {
      hasEdits = true;
      log.appendLine(
        `[cli-inline:timing] Edits confirmed: ${Date.now() - tSend}ms`,
      );
      resolveOnEdit?.();
    }
  }

  // Listen for edits applied via IPC — this fires immediately when WorkspaceEdit succeeds,
  // before the MCP response even reaches the CLI stream
  const ipcEditSub = ipcServer.onEdit((_filePath, _count, focusRange) => {
    markEditsApplied();
    log.appendLine(`[EDIT]: Edit appended: ${JSON.stringify(focusRange)}`);
    if (focusRange) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const range = new vscode.Range(
          focusRange.startLine,
          focusRange.startChar,
          focusRange.endLine,
          focusRange.endChar,
        );
        editor.revealRange(
          range,
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        editor.selection = new vscode.Selection(range.start, range.start);
      }
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

        // Readable debug logging with timestamps
        const ms = Date.now() - tSend;
        if (msg.type === "assistant") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            const summary = content
              .map((b: any) => {
                if (b.type === "tool_use") return `tool_use:${b.name}`;
                if (b.type === "thinking") return "thinking";
                if (b.type === "text")
                  return `text:"${b.text?.slice(0, 100) ?? ""}"`;
                return b.type;
              })
              .join(", ");
            log.appendLine(`[cli-inline +${ms}ms] assistant: [${summary}]`);
          }
        } else if (msg.type === "user") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            const summary = content
              .map((b: any) => {
                if (b.type === "tool_result") {
                  const resultText = Array.isArray(b.content)
                    ? b.content
                        .map((c: any) => c.text ?? "")
                        .join("")
                        .slice(0, 300)
                    : String(b.content ?? "").slice(0, 300);
                  return `tool_result(${b.is_error ? "ERROR" : "ok"}): "${resultText}"`;
                }
                return b.type;
              })
              .join(", ");
            log.appendLine(`[cli-inline +${ms}ms] user: [${summary}]`);
          }
        } else if (msg.type === "result") {
          log.appendLine(
            `[cli-inline +${ms}ms] result: subtype=${msg.subtype}, turns=${msg.num_turns}, cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"}`,
          );
        } else if (msg.type === "system") {
          log.appendLine(`[cli-inline +${ms}ms] system: ${msg.subtype ?? ""}`);
        } else if (
          msg.type !== "stream_event" &&
          msg.type !== "rate_limit_event"
        ) {
          log.appendLine(`[cli-inline +${ms}ms] ${msg.type}`);
        }

        if (msg.type === "stream_event") {
          const evt = msg.event;

          if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "tool_use") {
              const toolName = evt.content_block.name ?? "unknown";

              const isEditOrWrite =
                toolName === "mcp__codespark__edit_file" ||
                toolName === "Edit" ||
                toolName === "Write" ||
                toolName === "edit" ||
                toolName === "write";

              if (isEditOrWrite) {
                editToolSeen = true;
              }

              if (!firstToolSeen) {
                firstToolSeen = true;
                log.appendLine(
                  `[cli-inline:timing] First tool call: ${Date.now() - tSend}ms`,
                );
                if (!isEditOrWrite && onAgentMode) {
                  onAgentMode();
                }
              }
            }

            // Text block starting after edits = model is summarizing, all edits are on disk
            if (evt.content_block?.type === "text" && editToolSeen) {
              markEditsApplied();
            }
          }

          if (evt?.type === "message_start") {
            numTurns++;
          }
        }

        if (msg.type === "assistant") {
          const usage = msg.message?.usage;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
          }
        }

        if (msg.type === "result") {
          if (editToolSeen) {
            markEditsApplied();
          }

          if (msg.subtype === "success") {
            log.appendLine(
              `[cli-inline] Done (${msg.num_turns ?? numTurns} turns, $${msg.total_cost_usd?.toFixed(4) ?? "?"})`,
            );
          } else {
            const errors = msg.errors?.join("; ") ?? "Unknown error";
            log.appendLine(`[cli-inline] Error: ${errors}`);
            rejectOnDone?.(new Error(errors));
            return;
          }

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

  // Wait for edits or process completion
  await Promise.race([editDonePromise, donePromise]);
  ipcEditSub.dispose();

  const latencyMs = Date.now() - tSend;
  log.appendLine(`[cli-inline:timing] Total (user-perceived): ${latencyMs}ms`);

  return {
    hasEdits,
    latencyMs,
    inputTokens,
    outputTokens,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  };
}
