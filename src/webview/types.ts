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

export type WebviewToExtension =
  | SendMessage
  | CancelMessage
  | ClearMessage
  | ReadyMessage;

export interface InitMessage {
  type: "init";
  hasContext: boolean;
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
}
export interface ToolEndMessage {
  type: "tool-end";
  tool: string;
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

export type ExtensionToWebview =
  | InitMessage
  | TurnStartMessage
  | TokenMessage
  | ToolStartMessage
  | ToolEndMessage
  | ContextUpdatedMessage
  | DoneMessage
  | FocusMessage
  | ErrorMessage;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
