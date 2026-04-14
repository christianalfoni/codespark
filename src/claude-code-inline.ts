import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";

import { ResolvedContext, LLMResult } from "./types";
import { getResearchSummary } from "./research-agent";
import { EditedRange, IpcServer } from "./ipc-server";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code editing tool. You MUST respond with tool calls only. Never include text content blocks — your entire response must consist solely of tool_use blocks. Any text output is discarded and wastes time.

## Tools

- Use edit_file to modify files, write_file to create new files
- Batch multiple edits in a single edit_file call (e.g. import + code change = one call with two edits)
- Edit the current file LAST — do reads and other file edits first
- Do not read files already in context
- If the instruction references other files that would help (types, utilities, etc.), read them first

## Code Style Preservation

Preserve the existing code style of the file you are editing:
- Match indentation (tabs vs spaces, width)
- Match quote style (single vs double)
- Match semicolon usage
- Match trailing comma conventions
- Match bracket style (same-line vs next-line)
- Match naming conventions (camelCase, snake_case, PascalCase, etc.)
- Match import style (named vs default, grouping, ordering)
- Preserve blank line patterns between logical sections

Do not reformat code that you are not changing. Only touch lines relevant to the edit.

## Edit Quality

- Make the minimal change needed to fulfill the instruction
- Do not add code comments unless explicitly asked
- Do not add type annotations unless explicitly asked
- Do not add error handling unless explicitly asked
- Do not refactor surrounding code — only change what was requested
- Do not add imports that aren't needed for your change
- Remove imports that become unused due to your change

## Language Awareness

When editing, respect language-specific idioms:
- TypeScript/JavaScript: preserve module system (ESM vs CJS), respect strict mode, match existing type patterns (interfaces vs types, generics style)
- Python: respect PEP 8 unless the file deviates, preserve f-string vs format usage, match docstring style
- Rust: preserve ownership patterns, match error handling style (Result vs unwrap vs expect)
- Go: follow Go conventions (exported vs unexported, error returns), preserve formatting
- CSS/SCSS: match selector patterns, nesting depth, variable usage
- HTML/JSX: match attribute ordering, self-closing tag style
- For other languages, infer conventions from the existing code

## Multi-File Edits

When an instruction requires changes across multiple files:
- Read referenced files first to understand types, interfaces, and contracts
- Ensure type consistency across file boundaries
- Update imports in files that depend on changed exports
- Edit dependency files before the files that depend on them
- Edit the current (focused) file last

## Context Interpretation

- The user's cursor position and selection are provided — use them to understand which code the instruction targets
- **When no selection is provided**, the cursor line is the target. The user's instruction applies to the code at or near the cursor. Do NOT ask for clarification — infer the intent from the instruction and the code at the cursor line, then make the edit.
- When the user selects code and gives an instruction, apply the instruction to the selected code
- If the instruction says "here" or "this", it refers to the cursor position or selection
- Line numbers in the file content correspond to actual file lines — use them in edit_file calls
- If the instruction is ambiguous, prefer the interpretation that requires fewer changes
- Always make the edit. Never respond with only text — you must call edit_file or write_file.

## Common Operations

For frequently requested edits, follow these patterns:
- "Extract to function/method": create the function near related code, replace inline code with a call, add parameters for any values from the outer scope
- "Rename": change the declaration and all references in the file, update imports if exported
- "Add parameter": update the function signature, update all call sites in context
- "Convert/transform": maintain equivalent behavior while changing the form
- "Move": remove from source location, add to target location, update references
- "Inline": replace the reference with the implementation, remove the now-unused declaration`;

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
// Helpers
// ---------------------------------------------------------------------------

function formatFileContentWithLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Session pre-population — prime the model with file content + tool-use pattern
// ---------------------------------------------------------------------------

function encodeCwdPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
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
            text: "I've read the file, I'll evaluate if I need to do anything else first or use the edit_file tool immediately.",
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

// ---------------------------------------------------------------------------
// Prepared agent handle
// ---------------------------------------------------------------------------

export interface PreparedInlineAgent {
  proc: childProcess.ChildProcess;
  sessionFile: string;
}

/**
 * Pre-spawns the CLI with session containing fake file reads + assistant prefill
 * to prime the model for tool-only responses.
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
    "--include-partial-messages",
    "--tools",
    "Read",
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

  proc.on("error", (err) => {
    log.appendLine(`[cli-inline] Process error: ${err.message}`);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.appendLine(`[cli-inline:stderr] ${chunk.toString().trim()}`);
  });

  proc.on("exit", (code, signal) => {
    log.appendLine(
      `[cli-inline] Process exited (code=${code}, signal=${signal}, pid=${proc.pid})`,
    );
    fs.promises.unlink(sessionFile).catch(() => {});
  });

  // System prompt is sized to always exceed the prompt cache threshold (~4096 tokens
  // including CLI overhead), so we unconditionally pre-warm.
  const warmupMsg = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: "Ok, hold on. I'll tell you what to do next.",
    },
  });
  proc.stdin!.write(warmupMsg + "\n");

  return { proc, sessionFile };
}

/**
 * Abort a prepared agent that was never executed (e.g. user cancelled the prompt).
 */
export function abortInlineAgent(agent: PreparedInlineAgent): void {
  agent.proc.stdin?.end();
  agent.proc.kill();
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

  // File content is already in the session via fake Read results.
  // User message only needs the instruction + cursor context.
  const selectionPrefix = ctx.selection
    ? `\`\`\`\n${ctx.selection}\n\`\`\`\n\n`
    : "";
  const userInstruction = `I am currently looking at this area of the file ${ctx.filePath} (around line ${ctx.cursorLine}):\n\`\`\`\n${ctx.contextSnippet}\n\`\`\`\n\n${selectionPrefix}${ctx.instruction}`;

  const tSend = Date.now();
  log.appendLine(`[cli-inline] File: ${ctx.filePath}`);
  log.appendLine(`[cli-inline:prompt] ${ctx.instruction}`);

  // Set up readline first — must be before sending any messages
  const rl = readline.createInterface({ input: proc.stdout! });

  // Wait for the pre-warm result before sending the real instruction
  await new Promise<void>((resolve) => {
    const onLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "result") {
          rl.removeListener("line", onLine);
          resolve();
        }
      } catch {}
    };
    rl.on("line", onLine);
  });

  // Send instruction as stream-json user message
  const inputMsg = JSON.stringify({
    type: "user",
    message: { role: "user", content: userInstruction },
  });
  proc.stdin!.write(inputMsg + "\n");
  proc.stdin!.end();

  let hasEdits = false;
  let editToolSeen = false;
  let firstToolSeen = false;
  let textResponseContent = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let numTurns = 0;
  const editedLines: Array<{ startLine: number; endLine: number }> = [];

  // The system prompt instructs the model to edit the current file LAST,
  // so an IPC edit for this file means all edits are done.
  const currentFileAbs = path.resolve(workspaceFolder, ctx.filePath);

  let resolveOnCurrentFileEdit: (() => void) | undefined;
  const currentFileEditPromise = new Promise<void>((resolve) => {
    resolveOnCurrentFileEdit = resolve;
  });

  let resolveOnDone: (() => void) | undefined;
  let rejectOnDone: ((err: Error) => void) | undefined;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveOnDone = resolve;
    rejectOnDone = reject;
  });

  // Save the pre-edit cursor position so it can be restored on undo
  const preEditSelection = vscode.window.activeTextEditor?.selection;
  const preEditVisibleRange = vscode.window.activeTextEditor?.visibleRanges[0];

  // Listen for edits applied via IPC
  const ipcEditSub = ipcServer.onEdit((filePath, _count, editedRanges) => {
    if (!hasEdits) {
      hasEdits = true;
      log.appendLine(
        `[cli-inline:timing] First edit applied: ${Date.now() - tSend}ms`,
      );
    }
    editedLines.push(...editedRanges);

    // Current file edited = model is done (it edits the focused file last)
    if (filePath === currentFileAbs) {
      log.appendLine(
        `[cli-inline:timing] Current file edit applied: ${Date.now() - tSend}ms`,
      );
      resolveOnCurrentFileEdit?.();
    }

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return;
    }

    const cursorLine = editor.selection.active.line;

    // Check if any edited range touches the cursor line
    const editAtCursor = editedRanges.some(
      (r) => cursorLine >= r.startLine && cursorLine <= r.endLine,
    );

    if (editAtCursor) {
      return;
    }

    // Edit is away from cursor — find the largest range and smooth scroll to it
    let largest: EditedRange | undefined;
    for (const range of editedRanges) {
      const size = range.endLine - range.startLine + 1;
      if (!largest || size > largest.endLine - largest.startLine + 1) {
        largest = range;
      }
    }

    log.append(
      `[edit]: Found largest ${Boolean(largest)}, ${JSON.stringify(editedRanges)}`,
    );

    if (largest) {
      const range = new vscode.Range(largest.startLine, 0, largest.endLine, 0);

      vscode.commands.executeCommand("revealLine", {
        lineNumber: largest.startLine,
        at: "center",
      });

      editor.selection = new vscode.Selection(range.start, range.start);
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

        // Stream event handling
        if (msg.type === "stream_event") {
          const evt = msg.event;

          if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "tool_use") {
              const toolName = evt.content_block.name ?? "unknown";

              const isEditOrWrite =
                toolName === "mcp__codespark__edit_file" ||
                toolName === "mcp__codespark__write_file";

              if (isEditOrWrite) {
                editToolSeen = true;
              }

              if (!firstToolSeen) {
                firstToolSeen = true;
                log.appendLine(
                  `[cli-inline:timing] First tool call: ${ms}ms (${toolName})`,
                );
                if (!isEditOrWrite && onAgentMode) {
                  onAgentMode();
                }
              }
            }

            // (text blocks after edits no longer trigger early exit —
            // we wait for the full process to complete)
          }

          if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            textResponseContent += evt.delta.text ?? "";
          }

          if (evt?.type === "message_start") {
            numTurns++;
          }
        }

        // Token counting
        if (msg.type === "assistant") {
          const usage = msg.message?.usage;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
            cacheReadInputTokens += usage.cache_read_input_tokens || 0;
          }
        }

        if (msg.type === "result") {
          if (msg.subtype === "success") {
            if (!editToolSeen && textResponseContent.trim()) {
              log.appendLine(
                `[cli-inline:no-edit] LLM responded with text instead of edits: ${textResponseContent.trim()}`,
              );
            }
            log.appendLine(
              `[cli-inline] Done (${msg.num_turns ?? numTurns} turns, $${msg.total_cost_usd?.toFixed(4) ?? "?"})`,
            );
            log.appendLine(
              `[cli-inline:cache] creation=${cacheCreationInputTokens}, read=${cacheReadInputTokens}, input=${inputTokens}, output=${outputTokens}`,
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

  // Current file is edited last (per system prompt), so we can return as soon
  // as it lands. Fall back to waiting for full completion if no current-file
  // edit arrives (e.g. model only edited other files or responded with text).
  await Promise.race([currentFileEditPromise, donePromise]);
  ipcEditSub.dispose();

  const latencyMs = Date.now() - tSend;
  log.appendLine(`[cli-inline:timing] Total (user-perceived): ${latencyMs}ms`);

  return {
    hasEdits,
    editedLines,
    preEditSelection: preEditSelection
      ? {
          anchor: {
            line: preEditSelection.anchor.line,
            character: preEditSelection.anchor.character,
          },
          active: {
            line: preEditSelection.active.line,
            character: preEditSelection.active.character,
          },
        }
      : undefined,
    preEditVisibleRange: preEditVisibleRange
      ? {
          startLine: preEditVisibleRange.start.line,
          endLine: preEditVisibleRange.end.line,
        }
      : undefined,
    latencyMs,
    inputTokens,
    outputTokens,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  };
}
