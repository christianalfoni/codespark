// Message protocol between extension and webview

export interface SendMessage {
  type: "send";
  text: string;
}
export interface CancelMessage {
  type: "cancel";
}
export interface ClearMessage {
  type: "clear";
}
export interface ReadyMessage {
  type: "ready";
}

export interface OpenFileMessage {
  type: "open-file";
  path: string;
  line?: number;
}
export interface RunCommandMessage {
  type: "run-command";
  command: string;
}
export interface ReviewEditsMessage {
  type: "review-edits";
}
export interface SuggestionActionMessage {
  type: "suggestion-action";
  action: "approve-all" | "dismiss" | "diff";
  id?: string;
}
export interface NewSessionMessage {
  type: "new-session";
  currentEntries: import("./state").Entry[];
}
export interface SwitchSessionMessage {
  type: "switch-session";
  id: string;
  currentEntries: import("./state").Entry[];
}

export type WebviewToExtension =
  | SendMessage
  | CancelMessage
  | ClearMessage
  | ReadyMessage
  | OpenFileMessage
  | RunCommandMessage
  | NewSessionMessage
  | SwitchSessionMessage
  | ReviewEditsMessage
  | SuggestionActionMessage;

export interface SessionInfo {
  id: string;
  name: string;
  createdAt: number;
}

export interface InitMessage {
  type: "init";
  hasContext: boolean;
  sessions: SessionInfo[];
  activeSessionId: string | null;
}
export interface TurnStartMessage {
  type: "turn-start";
}
export interface TokenMessage {
  type: "token";
  text: string;
}
export interface ToolStartMessage {
  type: "tool-start";
  tool: string;
  toolId: number;
  description?: string;
}
export interface ToolEndMessage {
  type: "tool-end";
  tool: string;
  toolId: number;
  isError?: boolean;
  description?: string;
}
export interface ContextUpdatedMessage {
  type: "context-updated";
}
export interface DoneMessage {
  type: "done";
}
export interface FocusMessage {
  type: "focus";
}
export interface ErrorMessage {
  type: "error";
  text: string;
}
export interface SessionsUpdatedMessage {
  type: "sessions-updated";
  sessions: SessionInfo[];
  activeSessionId: string | null;
}
export interface RestoreMessage {
  type: "restore";
  entries: import("./state").Entry[];
  sessions: SessionInfo[];
  activeSessionId: string | null;
  hasContext: boolean;
}

export interface InjectUserMessage {
  type: "inject-user";
  text: string;
}

export interface SetFileContextMessage {
  type: "set-file-context";
  filePath: string | null;
  cursorLine: number;
  selection: string | null;
}
export interface EditLogCountMessage {
  type: "edit-log-count";
  count: number;
}
export interface ReviewSuggestionsMessage {
  type: "review-suggestions";
  suggestions: import("./state").ReviewSuggestion[];
}
export interface ReviewModeMessage {
  type: "review-mode";
  active: boolean;
}

export type ExtensionToWebview =
  | InitMessage
  | TurnStartMessage
  | TokenMessage
  | ToolStartMessage
  | ToolEndMessage
  | ContextUpdatedMessage
  | DoneMessage
  | FocusMessage
  | ErrorMessage
  | SessionsUpdatedMessage
  | RestoreMessage
  | InjectUserMessage
  | SetFileContextMessage
  | EditLogCountMessage
  | ReviewSuggestionsMessage
  | ReviewModeMessage;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
