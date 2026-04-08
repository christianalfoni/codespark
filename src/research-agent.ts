import * as vscode from "vscode";
import * as piAgentCore from "@mariozechner/pi-agent-core";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveModel } from "./llm-sdk";

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
// Custom tools
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
// Research agent
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM_PROMPT = `You are a research assistant for the CodeSpark coding extension. You can read workspace files and search the web, but you CANNOT edit or write files.

Research topics the user asks about — whether that's understanding code in the workspace, finding documentation online, or investigating how to approach a coding task. Respond naturally and conversationally to the user.

Your final response for each question will automatically be shared as context with the inline code editing agent (Cmd+I), so make sure your conclusions are clear and actionable — include specific file paths, function names, API details, and patterns where relevant.`;

let researchAgent: any;

export function ensureResearchAgent(
  piModel: any,
  apiKey: string,
  cwd: string,
  log: vscode.OutputChannel,
): any {
  const readOnlyTools = piCodingAgent.createReadOnlyTools(cwd);
  const webSearchTool = createWebSearchTool();
  const webFetchTool = createWebFetchTool();
  const tools = [...readOnlyTools, webSearchTool, webFetchTool];

  if (!researchAgent) {
    log.appendLine(
      `[research] Creating agent (model: ${piModel.id}, provider: ${piModel.provider})`,
    );
    researchAgent = new piAgentCore.Agent({
      initialState: {
        model: piModel,
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        tools,
        thinkingLevel: "off",
      },
      getApiKey: () => apiKey,
    });
  } else {
    researchAgent.abort();
    researchAgent.reset();
    researchAgent.state.model = piModel;
    researchAgent.state.systemPrompt = RESEARCH_SYSTEM_PROMPT;
    researchAgent.state.tools = tools;
    researchAgent.state.thinkingLevel = "off";
    researchAgent.getApiKey = () => apiKey;
    log.appendLine(
      `[research] Reusing agent (model: ${piModel.id}, provider: ${piModel.provider})`,
    );
  }

  return researchAgent;
}

export { resolveModel };
