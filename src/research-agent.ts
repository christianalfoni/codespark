import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as piAgentCore from "@mariozechner/pi-agent-core";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveModel, resolveResearchModel } from "./llm-sdk";
import type { Entry } from "./webview/state";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface ResearchSession {
  id: string;
  name: string;
  entries: Entry[];
  agentMessages: any[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Session store (backed by workspaceState)
// ---------------------------------------------------------------------------

const SESSIONS_KEY = "codeSpark.researchSessions";
const ACTIVE_SESSION_KEY = "codeSpark.activeResearchSession";
const MAX_SESSIONS = 5;
const MAX_SUMMARY_LENGTH = 4000;

let _workspaceState: vscode.Memento | undefined;
let _sessions: ResearchSession[] = [];
let _activeSessionId: string | null = null;

export function initResearchSummary(workspaceState: vscode.Memento): void {
  _workspaceState = workspaceState;
  _sessions = workspaceState.get<ResearchSession[]>(SESSIONS_KEY) ?? [];
  _activeSessionId = workspaceState.get<string>(ACTIVE_SESSION_KEY) ?? null;
}

function persistSessions(): void {
  _workspaceState?.update(SESSIONS_KEY, _sessions);
  _workspaceState?.update(ACTIVE_SESSION_KEY, _activeSessionId);
}

export function getSessions(): ResearchSession[] {
  return _sessions;
}

export function getActiveSessionId(): string | null {
  return _activeSessionId;
}

export function getActiveSession(): ResearchSession | undefined {
  return _sessions.find((s) => s.id === _activeSessionId);
}

export function getResearchSummary(): string | undefined {
  const session = getActiveSession();
  return session?.summary || undefined;
}

export function createSession(): ResearchSession {
  const session: ResearchSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    entries: [],
    agentMessages: [],
    summary: "",
  };
  _sessions.push(session);
  // Enforce max sessions — drop oldest
  while (_sessions.length > MAX_SESSIONS) {
    _sessions.shift();
  }
  _activeSessionId = session.id;
  persistSessions();
  return session;
}

export function switchSession(id: string): ResearchSession | undefined {
  const session = _sessions.find((s) => s.id === id);
  if (session) {
    _activeSessionId = id;
    persistSessions();
  }
  return session;
}

export function updateSessionEntries(id: string, entries: Entry[]): void {
  const session = _sessions.find((s) => s.id === id);
  if (session) {
    session.entries = entries;
    persistSessions();
  }
}

export function saveAgentMessages(id: string, messages: any[]): void {
  const session = _sessions.find((s) => s.id === id);
  if (session) {
    session.agentMessages = messages;
    persistSessions();
  }
}

export function appendResearchContext(
  sessionId: string,
  userPrompt: string,
  response: string,
  filesRead: string[],
  log: vscode.OutputChannel,
): void {
  const session = _sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // Name the session after the first query
  if (!session.name) {
    session.name = userPrompt.slice(0, 50);
  }

  const existing = session.summary;
  const parts: string[] = [];
  if (existing) parts.push(existing);

  let entry = `### Q: ${userPrompt}\n\n${response}`;
  if (filesRead.length > 0) {
    entry += `\n\nFiles referenced: ${filesRead.join(", ")}`;
  }
  parts.push(entry);

  const newContext = parts.join("\n\n---\n\n");
  session.summary = newContext.slice(-MAX_SUMMARY_LENGTH);

  persistSessions();
  log.appendLine(
    `[research] Session "${session.name}" context updated (${session.summary.length} chars)`,
  );
}

export function clearResearchSummary(): void {
  // Clear active session only
  const session = getActiveSession();
  if (session) {
    session.summary = "";
    persistSessions();
  }
}

export function getSessionInfos(): { id: string; name: string }[] {
  return _sessions.map((s) => ({ id: s.id, name: s.name || "New session" }));
}

// ---------------------------------------------------------------------------
// Low-level tools (used by sub-agents)
// ---------------------------------------------------------------------------

function createWebSearchTool(): piAgentCore.AgentTool {
  const schema = Type.Object({
    query: Type.String({ description: "The search query" }),
  }) as any;

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
  }) as any;

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
// Git tools (used by explore_codebase sub-agent)
// ---------------------------------------------------------------------------

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      args,
      { cwd, maxBuffer: 1024 * 256, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

function createGitStatusTool(cwd: string): piAgentCore.AgentTool {
  const schema = Type.Object({}) as any;

  return {
    name: "git_status",
    label: "Git Status",
    description:
      "Show the current git status: branch name, staged, modified, and untracked files.",
    parameters: schema,
    execute: async () => {
      const branch = await execGit(["branch", "--show-current"], cwd);
      const status = await execGit(["status", "--short"], cwd);
      const text = `Branch: ${branch}\n\n${status || "(clean working tree)"}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

function createGitLogTool(cwd: string): piAgentCore.AgentTool {
  const schema = Type.Object({
    count: Type.Optional(
      Type.Number({ description: "Number of commits to show (default 20)" }),
    ),
    file: Type.Optional(
      Type.String({ description: "Limit history to a specific file path" }),
    ),
    ref: Type.Optional(
      Type.String({ description: "Branch, tag, or commit ref to start from" }),
    ),
  }) as any;

  return {
    name: "git_log",
    label: "Git Log",
    description:
      "View git commit history. Returns commit hash, date, author, and message. Optionally filter by file or ref.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as { count?: number; file?: string; ref?: string };
      const args = [
        "log",
        `--max-count=${p.count ?? 20}`,
        "--format=%h %ad %an: %s",
        "--date=short",
        "--no-color",
      ];
      if (p.ref) args.push(p.ref);
      if (p.file) {
        args.push("--");
        args.push(p.file);
      }
      const text = await execGit(args, cwd);
      return {
        content: [{ type: "text", text: text || "(no commits found)" }],
        details: undefined,
      };
    },
  };
}

function createGitDiffTool(cwd: string): piAgentCore.AgentTool {
  const schema = Type.Object({
    ref: Type.Optional(
      Type.String({
        description:
          "Ref or ref range to diff (e.g. 'HEAD~3', 'main..feature', 'abc123'). Omit for unstaged working-tree changes.",
      }),
    ),
    staged: Type.Optional(
      Type.Boolean({
        description: "Show staged (cached) changes instead of unstaged",
      }),
    ),
    file: Type.Optional(
      Type.String({ description: "Limit diff to a specific file path" }),
    ),
  }) as any;

  return {
    name: "git_diff",
    label: "Git Diff",
    description:
      "Show a git diff. By default shows unstaged working-tree changes. Use 'staged' for cached changes, or provide a ref/range.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as { ref?: string; staged?: boolean; file?: string };
      const args = ["diff", "--no-color"];
      if (p.staged) args.push("--cached");
      if (p.ref) args.push(p.ref);
      if (p.file) {
        args.push("--");
        args.push(p.file);
      }
      const text = await execGit(args, cwd);
      return {
        content: [{ type: "text", text: text || "(no differences)" }],
        details: undefined,
      };
    },
  };
}

function createGitBlameTool(cwd: string): piAgentCore.AgentTool {
  const schema = Type.Object({
    file: Type.String({
      description: "File path to annotate (relative to workspace root)",
    }),
    startLine: Type.Optional(
      Type.Number({ description: "Start line number (1-based)" }),
    ),
    endLine: Type.Optional(
      Type.Number({ description: "End line number (1-based)" }),
    ),
  }) as any;

  return {
    name: "git_blame",
    label: "Git Blame",
    description:
      "Show git blame for a file — who last changed each line and when. Optionally limit to a line range.",
    parameters: schema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as {
        file: string;
        startLine?: number;
        endLine?: number;
      };
      const args = ["blame", "--no-color", "--date=short"];
      if (p.startLine && p.endLine) {
        args.push(`-L${p.startLine},${p.endLine}`);
      }
      args.push(p.file);
      const text = await execGit(args, cwd);
      return {
        content: [{ type: "text", text: text || "(no blame output)" }],
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
    log.appendLine(`[research:sub] Sub-agent done (${result.length} chars)`);
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
  }) as any;

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
  }) as any;

  const readOnlyTools = piCodingAgent.createReadOnlyTools(cwd);
  const gitTools = [
    createGitStatusTool(cwd),
    createGitLogTool(cwd),
    createGitDiffTool(cwd),
    createGitBlameTool(cwd),
  ];

  const systemPrompt = `You are a codebase exploration sub-agent. Your job is to read files in the workspace and inspect git state to answer questions about the code.

Use the available tools to navigate the codebase. Read relevant files, follow imports, and trace through the code to build understanding. Use git tools to check recent changes, authorship, diffs, and branch state when relevant.

Return a clear, structured summary of your findings. Include:
- Relevant file paths and line numbers
- Key code patterns, function signatures, or type definitions
- How different parts connect to each other
- Git context (recent changes, authors, branch info) when relevant

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
        [...readOnlyTools, ...gitTools],
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

function buildResearchSystemPrompt(workspaceFolder: string): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const platform =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";

  return `You are the research orchestrator for the CodeSpark coding extension. You help users understand code and find information by delegating to specialized sub-agents.

## Environment
- Current date: ${date}
- Platform: ${platform}
- Editor: VS Code

## Workspace
- Workspace root: ${workspaceFolder}
- All file paths in your responses should be relative to the workspace root
- Example: Use \`src/foo.ts\` not \`/Users/name/project/src/foo.ts\`

## Tools

You have two powerful tools:
- **search_and_summarize**: Delegates web research to a fast sub-agent that searches and reads web pages. Use this for documentation, API references, tutorials, specs, etc.
- **explore_codebase**: Delegates codebase exploration to a fast sub-agent that reads workspace files and inspects git state. Use this for understanding code structure, finding implementations, tracing logic, checking recent changes, diffs, blame, and branch status.

**Call multiple tools in parallel whenever possible.** For example, if the user asks something that involves both understanding their code AND looking up documentation, call both explore_codebase and search_and_summarize in the same response — they will run concurrently.

## Formatting

- When referencing workspace file paths, use inline code: \`src/foo.ts\` or \`src/foo.ts:42\`. These become clickable links that open the file in the editor.
- When suggesting terminal commands, always use a fenced code block with the \`bash\` language tag — these become executable by the user with one click. Never put terminal commands in inline code. **Put each command in its own separate code block** so the user can run them individually.

## Your role

1. **Do not rely on training data.** When the question involves specific APIs, libraries, frameworks, or codebase details, use your tools to look up the current state rather than assuming based on what you already know — training data can be outdated or wrong.
2. Break the user's question into the right sub-tasks
3. Delegate to sub-agents via tools
4. Synthesize their findings into a clear, actionable answer

Your final response for each question will automatically be shared as context with the inline code editing agent (Cmd+I), so make sure your conclusions are clear and actionable — include specific file paths, function names, API details, and patterns where relevant.`;
}

// Map of session id → live Agent instance (kept in memory, not persisted)
const _liveAgents = new Map<string, any>();

function buildTools(
  subModel: any,
  apiKey: string,
  cwd: string,
  log: vscode.OutputChannel,
): piAgentCore.AgentTool[] {
  return [
    createSearchAndSummarizeTool(subModel, apiKey, log),
    createExploreCodebaseTool(subModel, apiKey, cwd, log),
  ];
}

export function createResearchAgent(
  headModel: any,
  subAgentModel: any,
  apiKey: string,
  cwd: string,
  log: vscode.OutputChannel,
  sessionId: string,
  savedMessages?: any[],
): any {
  const tools = buildTools(subAgentModel, apiKey, cwd, log);

  const agent = new piAgentCore.Agent({
    initialState: {
      model: headModel,
      systemPrompt: buildResearchSystemPrompt(cwd),
      tools,
      thinkingLevel: "off",
      ...(savedMessages ? { messages: savedMessages } : {}),
    },
    getApiKey: () => apiKey,
  });

  _liveAgents.set(sessionId, agent);

  log.appendLine(
    `[research] ${savedMessages ? "Restored" : "Created"} agent for session ${sessionId} (head: ${headModel.id}, sub: ${subAgentModel.id})`,
  );

  return agent;
}

export function getLiveAgent(sessionId: string): any | undefined {
  return _liveAgents.get(sessionId);
}

export function disposeLiveAgent(sessionId: string): void {
  const agent = _liveAgents.get(sessionId);
  if (agent) {
    agent.abort();
    _liveAgents.delete(sessionId);
  }
}

export { resolveModel, resolveResearchModel };
