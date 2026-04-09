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
  | SwitchSessionMessage;

export interface SessionInfo {
  id: string;
  name: string;
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
}
export interface ToolEndMessage {
  type: "tool-end";
  tool: string;
  toolId: number;
  isError?: boolean;
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
  | RestoreMessage;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
