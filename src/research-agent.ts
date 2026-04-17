import * as vscode from "vscode";
import type { Entry } from "./webview/state";
import {
  createResearchQuery,
  iterateResearchEvents,
  type ResearchQueryHandle,
} from "./claude-code-research";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface WorkItemData {
  title: string;
  description: string;
  filePath: string;
  lineHint?: number;
}

export interface ResearchSession {
  id: string;
  name: string;
  entries: Entry[];
  agentMessages: any[];
  summary: string;
  workItems: WorkItemData[];
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
  if (!session) return undefined;

  const parts: string[] = [];

  // Include work items if present
  const workItems = session.workItems;
  if (workItems && workItems.length > 0) {
    const itemLines = workItems.map((item, i) =>
      `${i + 1}. **${item.title}** — \`${item.filePath}${item.lineHint ? `:${item.lineHint}` : ""}\`\n   ${item.description}`,
    );
    parts.push(`## Work Items\n\n${itemLines.join("\n\n")}`);
  }

  if (session.summary) {
    parts.push(session.summary);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}



export function createSession(name?: string): ResearchSession {
  const session: ResearchSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name ?? "",
    entries: [],
    agentMessages: [],
    summary: "",
    workItems: [],
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

export function deleteSession(id: string): void {
  const idx = _sessions.findIndex((s) => s.id === id);
  if (idx !== -1) {
    _sessions.splice(idx, 1);
    persistSessions();
  }
}

export function updateSessionEntries(id: string, entries: Entry[]): void {
  const session = _sessions.find((s) => s.id === id);
  if (session) {
    session.entries = entries;
    persistSessions();
  }
}

export function saveWorkItems(id: string, items: WorkItemData[]): void {
  const session = _sessions.find((s) => s.id === id);
  if (session) {
    session.workItems = items;
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
  session.summary = newContext;

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

export function getSessionInfos(): { id: string; name: string; createdAt: number }[] {
  return _sessions.map((s) => {
    // Extract timestamp from session id: "session-<timestamp>-<random>"
    const ts = parseInt(s.id.split("-")[1], 10) || Date.now();
    return { id: s.id, name: s.name || "New session", createdAt: ts };
  });
}

// ---------------------------------------------------------------------------
// Live research query management
// ---------------------------------------------------------------------------

const _liveQueries = new Map<string, ResearchQueryHandle>();

/**
 * Start a new research query. If a live process already exists for this session,
 * send the message to it via stdin instead of spawning a new process.
 * Returns the handle and a boolean indicating whether this is a follow-up
 * message on an existing process (true) or a fresh spawn (false).
 */
export function startResearchQuery(
  prompt: string,
  cwd: string,
  log: vscode.OutputChannel,
  sessionId: string,
  mcpConfigPath?: string,
  resumeSdkSessionId?: string,
): { handle: ResearchQueryHandle; isFollowUp: boolean } {
  const existing = _liveQueries.get(sessionId);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    log.appendLine(`[research-agent] Sending follow-up to existing process for session ${sessionId}`);
    existing.sendMessage(prompt);
    return { handle: existing, isFollowUp: true };
  }

  const handle = createResearchQuery(prompt, cwd, log, mcpConfigPath, resumeSdkSessionId);
  _liveQueries.set(sessionId, handle);
  return { handle, isFollowUp: false };
}

export function getLiveQuery(sessionId: string): ResearchQueryHandle | undefined {
  return _liveQueries.get(sessionId);
}

export function abortLiveQuery(sessionId: string): void {
  const handle = _liveQueries.get(sessionId);
  if (handle) {
    handle.process.kill();
    _liveQueries.delete(sessionId);
  }
}

export function disposeLiveQuery(sessionId: string): void {
  abortLiveQuery(sessionId);
}

export { iterateResearchEvents } from "./claude-code-research";
