import * as vscode from "vscode";
import * as piAgentCore from "@mariozechner/pi-agent-core";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveModel, resolveResearchModel } from "./llm-sdk";

// ---------------------------------------------------------------------------
// Summary store (backed by workspaceState)
// ---------------------------------------------------------------------------

let _workspaceState: vscode.Memento | undefined;
let _summaryCache: string | undefined;

const SUMMARY_KEY = "codeSpark.researchSummary";
const MAX_SUMMARY_LENGTH = 4000;

export function initResearchSummary(workspaceState: vscode.Memento): void {
  _workspaceState = workspaceState;
  _summaryCache = workspaceState.get<string>(SUMMARY_KEY);
}

export function getResearchSummary(): string | undefined {
  return _summaryCache;
}

function setResearchSummary(summary: string): void {
  const trimmed = summary.slice(0, MAX_SUMMARY_LENGTH);
  _summaryCache = trimmed;
  _workspaceState?.update(SUMMARY_KEY, trimmed);
}

export function clearResearchSummary(): void {
  _summaryCache = undefined;
  _workspaceState?.update(SUMMARY_KEY, undefined);
}

export function appendResearchContext(
  userPrompt: string,
  response: string,
  filesRead: string[],
  log: vscode.OutputChannel,
): void {
  const existing = _summaryCache ?? "";

  const parts: string[] = [];
  if (existing) parts.push(existing);

  let entry = `### Q: ${userPrompt}\n\n${response}`;
  if (filesRead.length > 0) {
    entry += `\n\nFiles referenced: ${filesRead.join(", ")}`;
  }
  parts.push(entry);

  const newContext = parts.join("\n\n---\n\n");
  const trimmed = newContext.slice(-MAX_SUMMARY_LENGTH);

  _summaryCache = trimmed;
  _workspaceState?.update(SUMMARY_KEY, trimmed);
  log.appendLine(`[research] Inline context updated (${trimmed.length} chars)`);
}

// ---------------------------------------------------------------------------
// Low-level tools (used by sub-agents)
// ---------------------------------------------------------------------------

function createWebSearchTool(): piAgentCore.AgentTool {
  const schema = Type.Object({
    query: Type.String({ description: "The search query" }),
  });

  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search. Returns titles, URLs, and snippets.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string };
      const apiKey = vscode.workspace
        .getConfiguration("codeSpark")
        .get<string>("braveApiKey", "");

      if (!apiKey) {
        throw new Error(
          "Brave Search API key not configured. Set codeSpark.braveApiKey in settings.",
        );
      }

      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=10`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });

      if (!res.ok) {
        throw new Error(
          `Brave Search API error: ${res.status} ${res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
          }>;
        };
      };
      const results = data.web?.results ?? [];

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title ?? "Untitled"}\n   ${r.url ?? ""}\n   ${r.description ?? ""}`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted || "No results found." }],
        details: undefined,
      };
    },
  };
}

function createWebFetchTool(): piAgentCore.AgentTool {
  const schema = Type.Object({
    url: Type.String({ description: "The URL to fetch" }),
  });

  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and return its text content (HTML tags stripped).",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { url: string };
      const res = await fetch(params.url, {
        headers: {
          "User-Agent": "CodeSpark-Research/1.0",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        throw new Error(`Fetch error: ${res.status} ${res.statusText}`);
      }

      let text = await res.text();

      // Strip scripts and styles first, then all HTML tags
      text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
      text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
      text = text.replace(/<[^>]+>/g, " ");
      // Collapse whitespace
      text = text.replace(/\s+/g, " ").trim();
      // Truncate
      const maxLen = 50000;
      if (text.length > maxLen) {
        text = text.slice(0, maxLen) + "\n\n[truncated]";
      }

      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-agent runner
// ---------------------------------------------------------------------------

function extractAssistantText(agent: any): string {
  const messages: any[] = agent.state.messages ?? [];
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") break;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          parts.unshift(block.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

async function runSubAgent(
  subModel: any,
  apiKey: string,
  systemPrompt: string,
  tools: piAgentCore.AgentTool[],
  task: string,
  log: vscode.OutputChannel,
): Promise<string> {
  const sub = new piAgentCore.Agent({
    initialState: {
      model: subModel,
      systemPrompt,
      tools,
      thinkingLevel: "off",
    },
    getApiKey: () => apiKey,
  });

  log.appendLine(
    `[research:sub] Spawning sub-agent (model: ${subModel.id}) — ${task.slice(0, 80)}`,
  );

  try {
    sub.prompt(task);
    await sub.waitForIdle();
    const result = extractAssistantText(sub);
    log.appendLine(
      `[research:sub] Sub-agent done (${result.length} chars)`,
    );
    return result || "(sub-agent returned no text)";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[research:sub] Sub-agent error: ${msg}`);
    return `Error: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Compound tools (used by head agent, spawn sub-agents)
// ---------------------------------------------------------------------------

function createSearchAndSummarizeTool(
  subModel: any,
  apiKey: string,
  log: vscode.OutputChannel,
): piAgentCore.AgentTool {
  const schema = Type.Object({
    query: Type.String({
      description: "The search query or research question",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Additional context to help the sub-agent understand what to look for",
      }),
    ),
  });

  const webSearchTool = createWebSearchTool();
  const webFetchTool = createWebFetchTool();

  const systemPrompt = `You are a web research sub-agent. Your job is to search the web and gather information to answer the given question.

Use web_search to find relevant results, then use web_fetch to read the most promising pages. You may search multiple times with different queries if the first results aren't sufficient.

Return a clear, structured summary of your findings. Include:
- Key facts and details that answer the question
- Relevant URLs for attribution
- Code examples or API details if applicable

Be thorough but concise. Focus on actionable information.`;

  return {
    name: "search_and_summarize",
    label: "Search & Summarize",
    description:
      "Search the web and return a summarized answer. Use this for any web research — documentation lookups, API references, how-to guides, etc. A sub-agent will search, read pages, and return a synthesis.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; context?: string };
      const task = params.context
        ? `${params.query}\n\nContext: ${params.context}`
        : params.query;

      const result = await runSubAgent(
        subModel,
        apiKey,
        systemPrompt,
        [webSearchTool, webFetchTool],
        task,
        log,
      );

      return {
        content: [{ type: "text", text: result }],
        details: undefined,
      };
    },
  };
}

function createExploreCodebaseTool(
  subModel: any,
  apiKey: string,
  cwd: string,
  log: vscode.OutputChannel,
): piAgentCore.AgentTool {
  const schema = Type.Object({
    question: Type.String({
      description:
        "What to explore or find out about the codebase (e.g. 'How does authentication work?', 'Find all API endpoints', 'What does the User model look like?')",
    }),
  });

  const readOnlyTools = piCodingAgent.createReadOnlyTools(cwd);

  const systemPrompt = `You are a codebase exploration sub-agent. Your job is to read files in the workspace to answer questions about the code.

Use the available tools to navigate the codebase. Read relevant files, follow imports, and trace through the code to build understanding.

Return a clear, structured summary of your findings. Include:
- Relevant file paths and line numbers
- Key code patterns, function signatures, or type definitions
- How different parts connect to each other

Be thorough but concise. Include actual code snippets where they help explain the answer.`;

  return {
    name: "explore_codebase",
    label: "Explore Codebase",
    description:
      "Explore the workspace codebase to answer a question. A sub-agent will read files, follow imports, and return a structured summary of its findings. Use this for understanding code structure, finding implementations, tracing data flow, etc.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { question: string };

      const result = await runSubAgent(
        subModel,
        apiKey,
        systemPrompt,
        readOnlyTools,
        params.question,
        log,
      );

      return {
        content: [{ type: "text", text: result }],
        details: undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Research agent (head)
// ---------------------------------------------------------------------------

function buildResearchSystemPrompt(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

  return `You are the research orchestrator for the CodeSpark coding extension. You help users understand code and find information by delegating to specialized sub-agents.

## Environment
- Current date: ${date}
- Platform: ${platform}
- Editor: VS Code

## Tools

You have two powerful tools:
- **search_and_summarize**: Delegates web research to a fast sub-agent that searches and reads web pages. Use this for documentation, API references, tutorials, specs, etc.
- **explore_codebase**: Delegates codebase exploration to a fast sub-agent that reads workspace files. Use this for understanding code structure, finding implementations, tracing logic, etc.

**Call multiple tools in parallel whenever possible.** For example, if the user asks something that involves both understanding their code AND looking up documentation, call both explore_codebase and search_and_summarize in the same response — they will run concurrently.

## Formatting

- When referencing workspace file paths, use inline code: \`src/foo.ts\` or \`src/foo.ts:42\`. These become clickable links that open the file in the editor.
- When suggesting terminal commands, always use a fenced code block with the \`bash\` language tag — these become executable by the user with one click. Never put terminal commands in inline code.

## Your role

1. Break the user's question into the right sub-tasks
2. Delegate to sub-agents via tools
3. Synthesize their findings into a clear, actionable answer

Your final response for each question will automatically be shared as context with the inline code editing agent (Cmd+I), so make sure your conclusions are clear and actionable — include specific file paths, function names, API details, and patterns where relevant.`;
}

let researchAgent: any;

export function ensureResearchAgent(
  headModel: any,
  subAgentModel: any,
  apiKey: string,
  cwd: string,
  log: vscode.OutputChannel,
): any {
  const searchTool = createSearchAndSummarizeTool(subAgentModel, apiKey, log);
  const exploreTool = createExploreCodebaseTool(
    subAgentModel,
    apiKey,
    cwd,
    log,
  );
  const tools = [searchTool, exploreTool];

  if (!researchAgent) {
    log.appendLine(
      `[research] Creating head agent (head: ${headModel.id}, sub: ${subAgentModel.id})`,
    );
    researchAgent = new piAgentCore.Agent({
      initialState: {
        model: headModel,
        systemPrompt: buildResearchSystemPrompt(),
        tools,
        thinkingLevel: "off",
      },
      getApiKey: () => apiKey,
    });
  } else {
    researchAgent.abort();
    researchAgent.reset();
    researchAgent.state.model = headModel;
    researchAgent.state.systemPrompt = buildResearchSystemPrompt();
    researchAgent.state.tools = tools;
    researchAgent.state.thinkingLevel = "off";
    researchAgent.getApiKey = () => apiKey;
    log.appendLine(
      `[research] Reusing head agent (head: ${headModel.id}, sub: ${subAgentModel.id})`,
    );
  }

  return researchAgent;
}

export { resolveModel, resolveResearchModel };
