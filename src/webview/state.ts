import type { BreakdownStep, ChatMessage, SessionInfo } from "./types";

export type ToolStatus = "pending" | "success" | "error";

export interface ToolEntry {
  id: number;
  name: string;
  description?: string;
  status: ToolStatus;
}

/** A single LLM turn within one assistant response */
export interface Turn {
  text: string;
  tools: ToolEntry[];
}

/** An assistant response is made up of multiple turns */
export interface AssistantEntry {
  role: "assistant";
  turns: Turn[];
}

export interface UserEntry {
  role: "user";
  content: string;
}

export type Entry = UserEntry | AssistantEntry;

export type ContextState = "none" | "pending" | "ready";

export interface ChatState {
  entries: Entry[];
  isStreaming: boolean;
  activeTool: string | null;
  contextState: ContextState;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  fileContext: { filePath: string; cursorLine: number; selection?: string } | null;
  breakdownSteps: BreakdownStep[];
  selectedStepIndex: number | null;
  stepStatuses: Map<number, { status: "applying" | "done" | "error"; text?: string }>;
}

export function createInitialState(saved: any): ChatState {
  const state: ChatState = {
    entries: [],
    isStreaming: false,
    activeTool: null,
    contextState: "none",
    sessions: [],
    activeSessionId: null,
    fileContext: null,
    breakdownSteps: [],
    selectedStepIndex: null,
    stepStatuses: new Map(),
  };

  if (saved?.entries) {
    state.entries = saved.entries;
  } else if (saved?.messages) {
    // Migrate from old format
    for (const msg of saved.messages as ChatMessage[]) {
      if (msg.role === "user") {
        state.entries.push({ role: "user", content: msg.content });
      } else {
        state.entries.push({
          role: "assistant",
          turns: [{ text: msg.content, tools: [] }],
        });
      }
    }
  }

  if (saved?.sessions) {
    state.sessions = saved.sessions;
  }
  if (saved?.activeSessionId) {
    state.activeSessionId = saved.activeSessionId;
  }

  return state;
}

export function getFullText(entry: AssistantEntry): string {
  return entry.turns.map((t) => t.text).join("");
}

export function getAllTools(entry: AssistantEntry): ToolEntry[] {
  const tools: ToolEntry[] = [];
  for (const turn of entry.turns) {
    for (const t of turn.tools) {
      tools.push(t);
    }
  }
  return tools;
}

export function countTurns(entries: Entry[]): number {
  let n = 0;
  for (const entry of entries) {
    if (entry.role === "assistant") n += entry.turns.length;
  }
  return n;
}

export function serializeConversation(entries: Entry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.role === "user") {
      parts.push(`[user]:\n\n${entry.content}`);
    } else {
      const text = getFullText(entry).trim();
      if (text) parts.push(`[assistant]:\n\n${text}`);
    }
  }
  return parts.join("\n\n");
}
