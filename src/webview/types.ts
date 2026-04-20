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
export interface SelectStepMessage {
  type: "select-step";
  index: number | null;
}
export interface ApplyStepMessage {
  type: "apply-step";
  index: number;
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
  | SelectStepMessage
  | ApplyStepMessage;

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
  numTurns?: number;
  totalCostUsd?: number;
}
export interface UsageMessage {
  type: "usage";
  source: "assistant" | "inline";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
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

export interface BreakdownStep {
  title: string;
  description: string;
  filePath: string;
  lineHint?: number;
}

export interface BreakdownMessage {
  type: "breakdown";
  steps: BreakdownStep[];
}

export interface StepStatusMessage {
  type: "step-status";
  index: number;
  status: "applying" | "done" | "error";
  text?: string;
}

export type ExtensionToWebview =
  | InitMessage
  | TurnStartMessage
  | TokenMessage
  | ToolStartMessage
  | ToolEndMessage
  | ContextUpdatedMessage
  | DoneMessage
  | UsageMessage
  | FocusMessage
  | ErrorMessage
  | SessionsUpdatedMessage
  | RestoreMessage
  | InjectUserMessage
  | SetFileContextMessage
  | BreakdownMessage
  | StepStatusMessage;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
