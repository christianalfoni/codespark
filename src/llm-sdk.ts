import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LLMResult, ResolvedContext } from "./types";
import {
  registerVscodeLmProvider,
  selectVscodeLmModel,
} from "./vscode-lm-provider";

import * as piAi from "@mariozechner/pi-ai";
import * as piAgentCore from "@mariozechner/pi-agent-core";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";

let vscodeLmRegistered = false;
let _log: vscode.OutputChannel;

async function loadPiModules() {
  if (!vscodeLmRegistered && _log) {
    piAi.registerBuiltInApiProviders();
    await registerVscodeLmProvider(piAi, _log);
    vscodeLmRegistered = true;
  }
}

const SYSTEM_PROMPT = `You are a code editor assistant. The user will show you a file and tell you what they want changed. Use the edit tool to make the changes. Do NOT read the file — it has already been read into context.

Do not add code comments unless the user explicitly asks for them.

The user will indicate where they are looking in the file. Make edits in that area based on their instruction. You may make multiple edits if needed (e.g. updating imports alongside the main change).

Only edit the file specified. Do not create new files. Do not run commands. Just make the requested edits.

Do not read files that are already in context. If the user's instruction references other files that would help you make better edits (e.g. types, interfaces, utilities, or related components), use the read tool to read them before editing.`;

const SYSTEM_PROMPT_CLAUDE_MD = `You are editing an instruction file (CLAUDE.md or AGENT.md). These files provide instructions and context to AI code editors when working with files in this directory.

Good content includes:
- Project patterns and conventions (naming, structure, idioms)
- API usage patterns and preferred libraries
- Rules and constraints for code in this directory
- Key types, interfaces, or data structures to be aware of
- Common pitfalls or non-obvious behavior

Write in markdown format. Be concise and practical — write for an AI that already understands programming.

Use the edit tool to make changes.`;

function buildSystemPrompt(ctx: ResolvedContext): string {
  if (ctx.isInstructionFile) {
    return SYSTEM_PROMPT_CLAUDE_MD;
  }

  if (!ctx.instructionContent) {
    return SYSTEM_PROMPT;
  }

  return `${SYSTEM_PROMPT}\n\n# CLAUDE.md\n\n${ctx.instructionContent}`;
}

function numberLines(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

let agent: any;

function createVscodeEditOperations(activeFilePath: string) {
  return {
    readFile: async (absolutePath: string) => {
      if (absolutePath === activeFilePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (doc) {
          return Buffer.from(doc.getText());
        }
      }
      return fs.promises.readFile(absolutePath);
    },
    writeFile: async (absolutePath: string, content: string) => {
      if (absolutePath === activeFilePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (doc) {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length),
          );
          edit.replace(uri, fullRange, content);
          await vscode.workspace.applyEdit(edit);
          return;
        }
      }
      fs.writeFileSync(absolutePath, content);
    },
    access: async (absolutePath: string) => {
      await fs.promises.access(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
    },
  };
}

function createVscodeWriteOperations(activeFilePath: string) {
  return {
    writeFile: async (absolutePath: string, content: string) => {
      if (absolutePath === activeFilePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (doc) {
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length),
          );
          edit.replace(uri, fullRange, content);
          await vscode.workspace.applyEdit(edit);
          return;
        }
      }
      fs.writeFileSync(absolutePath, content);
    },
    mkdir: async (dir: string) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
  };
}

function createReadOperations(activeFilePath: string) {
  return {
    readFile: async (absolutePath: string) => {
      const stat = await fs.promises.stat(absolutePath);
      if (stat.isDirectory()) {
        const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name
        );
        return Buffer.from(lines.join("\n"));
      }
      if (absolutePath === activeFilePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (doc) {
          return Buffer.from(doc.getText());
        }
      }
      return fs.promises.readFile(absolutePath);
    },
    access: async (absolutePath: string) => {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    },
  };
}

function createAgent(
  piModel: any,
  apiKey: string,
  cwd: string,
  activeFilePath: string,
  log: vscode.OutputChannel,
  onPayload?: () => void,
): any {
  log.appendLine(`[sdk] Creating agent (model: ${piModel.id}, provider: ${piModel.provider})`);

  const editOps = createVscodeEditOperations(activeFilePath);
  const writeOps = createVscodeWriteOperations(activeFilePath);
  const readOps = createReadOperations(activeFilePath);
  const editTool = piCodingAgent.createEditTool(cwd, { operations: editOps });
  const writeTool = piCodingAgent.createWriteTool(cwd, { operations: writeOps });
  const readTool = piCodingAgent.createReadTool(cwd, { operations: readOps });

  return new piAgentCore.Agent({
    initialState: {
      model: piModel,
      systemPrompt: "",
      tools: [readTool, editTool, writeTool],
      thinkingLevel: "off",
    },
    getApiKey: () => apiKey,
    onPayload: onPayload
      ? () => { onPayload(); return undefined; }
      : undefined,
  });
}

export function closeSession(): void {
  if (agent) {
    agent.abort();
    agent = undefined;
  }
}

let warmupPromise: Promise<void> | undefined;

export function warmupSession(log: vscode.OutputChannel): void {
  _log = log;
  warmupPromise = loadPiModules()
    .then(() => log.appendLine("[sdk] pi modules loaded"))
    .catch((err) => log.appendLine(`[sdk:warmup-error] ${err}`));
}

export async function callLLMWithSDK(
  ctx: ResolvedContext,
  log: vscode.OutputChannel,
  onAgentMode?: () => void,
): Promise<LLMResult> {
  const config = vscode.workspace.getConfiguration("codeSpark");
  const provider = config.get<string>("provider", "copilot");
  const apiKey = config.get<string>("apiKey", "");
  log.appendLine(`[sdk] Config: provider="${provider}", apiKey=${apiKey ? "set" : "empty"}`);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    throw new Error("No workspace folder open");
  }

  // Wait for warmup if still in progress
  if (warmupPromise) {
    await warmupPromise;
    warmupPromise = undefined;
  }

  await loadPiModules();

  // Default models per provider
  const DEFAULT_MODELS: Record<string, string> = {
    copilot: "claude-haiku-4.5",
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-4.1-mini",
    google: "gemini-2.5-flash",
    openrouter: "anthropic/claude-haiku-4-5-20251001",
    groq: "llama-4-scout-17b-16e-instruct",
    xai: "grok-3-mini",
    mistral: "mistral-medium-latest",
    together: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
  };

  // Resolve model based on provider
  let piModel: any;
  const model = config.get<string>("model", "") || DEFAULT_MODELS[provider] || "";

  if (provider === "copilot") {
    const result = await selectVscodeLmModel("copilot", model);
    if (!result) {
      throw new Error(
        `No Copilot model found for "${model}". Make sure GitHub Copilot is installed and signed in.`,
      );
    }
    piModel = result.piModel;
    log.appendLine(`[sdk] Using Copilot: ${result.vscodeLmModel.name}`);
  } else {
    if (!apiKey) {
      throw new Error(
        `${provider} provider requires an API key. Set codeSpark.apiKey in settings.`,
      );
    }

    if (provider === "together") {
      // Together AI is not a built-in pi-ai provider — use OpenAI-compatible API
      piModel = {
        id: model,
        name: model,
        api: "openai-completions",
        provider: "together",
        baseUrl: "https://api.together.xyz/v1",
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      };
    } else {
      piModel = piAi.getModel(provider, model as never);
    }
    log.appendLine(`[sdk] Using ${provider}: ${model}`);
  }

  const systemPrompt = buildSystemPrompt(ctx);

  const activeFilePath = path.resolve(workspaceFolder, ctx.filePath);
  log.appendLine(`[sdk] Model: ${piModel.id}`);
  log.appendLine(`[sdk] File: ${ctx.filePath}`);

  // Create a fresh agent per invocation — the active file determines tool routing
  if (agent) {
    agent.abort();
  }
  let requestSentTime = 0;
  const ag = createAgent(piModel, apiKey, workspaceFolder, activeFilePath, log, () => {
    requestSentTime = Date.now();
    log.appendLine(`[sdk:timing] LLM request sent`);
  });

  // Update system prompt and reset messages for this invocation
  ag.state.systemPrompt = systemPrompt;
  ag.state.messages = [];

  // Pre-populate with fake read tool turns so the model has file content in context
  const now = Date.now();
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: any[] = [];

  // Main edited file
  const readId = "read_0";
  messages.push(
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: readId, name: "read", arguments: { path: ctx.filePath } },
      ],
      api: piModel.api,
      provider: piModel.provider,
      model: piModel.id,
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: now,
    },
    {
      role: "toolResult",
      toolCallId: readId,
      toolName: "read",
      content: [{ type: "text", text: numberLines(ctx.fileContent) }],
      isError: false,
      timestamp: now,
    },
  );

  // Reference files from CLAUDE.md links
  for (let i = 0; i < ctx.referenceFiles.length; i++) {
    const ref = ctx.referenceFiles[i];
    const refId = `read_ref_${i}`;
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: refId, name: "read", arguments: { path: ref.path } },
        ],
        api: piModel.api,
        provider: piModel.provider,
        model: piModel.id,
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: now,
      },
      {
        role: "toolResult",
        toolCallId: refId,
        toolName: "read",
        content: [{ type: "text", text: numberLines(ref.content) }],
        isError: false,
        timestamp: now,
      },
    );
  }

  ag.state.messages = messages;

  // Log pre-populated messages
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content) {
      for (const c of msg.content) {
        if (c.type === "toolCall") {
          log.appendLine(`[sdk:context] pre-read: ${c.arguments?.path}`);
        }
      }
    }
  }

  // Build the user instruction (no file content needed — it's in the fake reads)
  const instruction = `I am currently looking at this area of the file ${ctx.filePath} (around line ${ctx.cursorLine}):\n\n\`\`\`\n${ctx.contextSnippet}\n\`\`\`\n\n${ctx.instruction}`;

  const startTime = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let turnIndex = 0;
  let totalLlmMs = 0;

  // Resolve as soon as an edit/write tool completes — don't wait for the follow-up turn
  let resolveOnToolDone: (() => void) | undefined;
  const toolDonePromise = new Promise<void>((resolve) => {
    resolveOnToolDone = resolve;
  });

  const toolStartTimes = new Map<string, number>();
  let firstToolSeen = false;

  const unsubscribe = ag.subscribe((event: any) => {
    const now = Date.now();

    if (event.type === "message_start" && event.message?.role === "assistant") {
      const ttft = requestSentTime ? now - requestSentTime : 0;
      log.appendLine(`[sdk:timing] LLM turn ${turnIndex} first token (TTFT: ${ttft}ms)`);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const streamMs = requestSentTime ? now - requestSentTime : 0;
      totalLlmMs += streamMs;
      log.appendLine(`[sdk:timing] LLM turn ${turnIndex} done (request: ${streamMs}ms)`);
      requestSentTime = 0;
      turnIndex++;
      const usage = event.message.usage;
      if (usage) {
        inputTokens += usage.input || 0;
        outputTokens += usage.output || 0;
      }
    }
    if (event.type === "tool_execution_start") {
      toolStartTimes.set(event.toolName + "_" + (event.args?.path || ""), now);
      log.appendLine(`[sdk:tool] ${event.toolName}(${JSON.stringify(event.args).slice(0, 200)})`);
      if (!firstToolSeen) {
        firstToolSeen = true;
        const isCurrentFile = event.args?.path === ctx.filePath;
        const isEdit = event.toolName === "edit" || event.toolName === "write";
        if (!(isCurrentFile && isEdit) && onAgentMode) {
          onAgentMode();
        }
      }
    }
    if (event.type === "tool_execution_end") {
      const key = event.toolName + "_" + (event.args?.path || "");
      const toolStart = toolStartTimes.get(key);
      const toolMs = toolStart ? now - toolStart : 0;
      if (event.isError) {
        log.appendLine(`[sdk:tool] ${event.toolName} ERROR (${toolMs}ms): ${JSON.stringify(event.result).slice(0, 300)}`);
      } else {
        log.appendLine(`[sdk:tool] ${event.toolName} done (${toolMs}ms)`);
      }
      if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
        resolveOnToolDone?.();
      }
    }
  });

  try {
    ag.prompt(instruction); // fire — don't await
    // Resolve when either: a tool completes (fast path) or the agent finishes (fallback)
    await Promise.race([toolDonePromise, ag.waitForIdle()]);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[sdk:error] ${errMsg}`);
    agent = undefined;
    throw err;
  } finally {
    unsubscribe();
  }

  const latencyMs = Date.now() - startTime;
  const overheadMs = latencyMs - totalLlmMs;
  log.appendLine(`[sdk:timing] Total: ${latencyMs}ms | LLM: ${totalLlmMs}ms | Overhead: ${overheadMs}ms (${turnIndex} turn${turnIndex !== 1 ? "s" : ""})`);

  return {
    edits: [],
    latencyMs,
    inputTokens,
    outputTokens,
    provider,
    model: piModel.id,
  };
}

