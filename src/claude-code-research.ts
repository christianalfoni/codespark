import * as childProcess from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchQueryHandle {
  process: childProcess.ChildProcess;
  /** SDK session ID, available after the `result` message */
  sdkSessionId?: string;
}

export type WebviewEvent =
  | { type: "turn-start" }
  | { type: "token"; text: string }
  | { type: "tool-start"; tool: string; toolId: number; description?: string }
  | { type: "tool-end"; tool: string; toolId: number; isError: boolean }
  | { type: "done"; resultText: string; sdkSessionId: string }
  | { type: "error"; text: string };

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildResearchSystemPrompt(workspaceFolder: string): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const platform =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";

  return `You are the research agent for the CodeSpark coding extension. You help users understand code and find information.

## Environment
- Current date: ${date}
- Platform: ${platform}
- Editor: VS Code

## Workspace
- Workspace root: ${workspaceFolder}
- All file paths in your responses should be relative to the workspace root
- Example: Use \`src/foo.ts\` not \`/Users/name/project/src/foo.ts\`

## Tools

You have powerful built-in tools:
- **Read**: Read files in the workspace
- **Glob**: Find files by pattern
- **Grep**: Search file contents with regex
- **WebSearch**: Search the web for documentation, APIs, tutorials, etc.
- **WebFetch**: Fetch and read web pages

**Call multiple tools in parallel whenever possible.** For example, if the user asks something that involves both understanding their code AND looking up documentation, call both web search and file reading tools in the same response — they will run concurrently.

## Formatting

- When referencing workspace file paths, always use clickable markdown links with the vscode://file protocol. Combine the workspace root with the relative path to form the full URI. For a specific location: [src/foo.ts:42](vscode://file${workspaceFolder}/src/foo.ts:42). For a file as a whole: [src/foo.ts](vscode://file${workspaceFolder}/src/foo.ts). The link text should use the short relative path for readability. These links open the file directly in the editor.
- When suggesting terminal commands, always use a fenced code block with the \`bash\` language tag — these become executable by the user with one click. Never put terminal commands in inline code. **Put each command in its own separate code block** so the user can run them individually.

## Your role

1. **Do not rely on training data.** When the question involves specific APIs, libraries, frameworks, or codebase details, use your tools to look up the current state rather than assuming based on what you already know — training data can be outdated or wrong.
2. **Do not describe your plan or approach.** Jump straight to tool calls. After receiving results, synthesize findings into a clear, actionable answer — do not restate the plan or repeat what the tools found verbatim.
3. Be thorough — read multiple files, search broadly, follow imports to understand how code connects.
4. Synthesize findings into a clear, actionable answer.

Your final response for each question will automatically be shared as context with the inline code editing agent (Cmd+I), so make sure your conclusions are clear and actionable — include specific file paths, function names, API details, and patterns where relevant.`;
}

// ---------------------------------------------------------------------------
// Spawn claude CLI
// ---------------------------------------------------------------------------

export function createResearchQuery(
  prompt: string,
  cwd: string,
  log: vscode.OutputChannel,
  resumeSessionId?: string,
): ResearchQueryHandle {
  log.appendLine(
    `[claude-code-research] Creating query (resume: ${resumeSessionId ?? "none"}) — ${prompt.slice(0, 100)}`,
  );

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--tools",
    "Read,Glob,Grep,WebSearch,WebFetch",
    "--system-prompt",
    buildResearchSystemPrompt(cwd),
  ];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  args.push(prompt);

  const proc = childProcess.spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.appendLine(`[claude-code-research:stderr] ${chunk.toString().trim()}`);
  });

  return { process: proc };
}

// ---------------------------------------------------------------------------
// Iterate NDJSON messages and yield webview events
// ---------------------------------------------------------------------------

function* flushPendingTools(
  pendingTools: Map<number, { tool: string; toolId: number }>,
): Generator<WebviewEvent> {
  for (const [, pending] of pendingTools) {
    yield {
      type: "tool-end",
      tool: pending.tool,
      toolId: pending.toolId,
      isError: false,
    };
  }
  pendingTools.clear();
}

export async function* iterateResearchEvents(
  handle: ResearchQueryHandle,
  log: vscode.OutputChannel,
): AsyncGenerator<WebviewEvent> {
  let toolIdCounter = 0;
  const pendingTools = new Map<number, { tool: string; toolId: number }>();
  let resultText = "";
  let sdkSessionId = "";
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
            pendingTools.set(evt.index, { tool: toolName, toolId });
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
        yield* flushPendingTools(pendingTools);

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

      if (msg.type === "result") {
        yield* flushPendingTools(pendingTools);

        sdkSessionId = msg.session_id ?? "";
        handle.sdkSessionId = sdkSessionId;
        if (msg.subtype === "success") {
          resultText = msg.result ?? lastAssistantText;
          log.appendLine(
            `[claude-code-research] Query complete (${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(4)})`,
          );
        } else {
          const errors = msg.errors?.join("; ") ?? "Unknown error";
          log.appendLine(`[claude-code-research] Query error: ${errors}`);
          yield { type: "error", text: errors };
        }
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[claude-code-research] Iteration error: ${errMsg}`);
    yield { type: "error", text: errMsg };
  }

  yield* flushPendingTools(pendingTools);

  yield {
    type: "done",
    resultText: resultText || lastAssistantText,
    sdkSessionId,
  };
}
