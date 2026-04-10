import { useEffect } from "preact/hooks";
import type * as preact from "preact";
import type { ExtensionToWebview, SessionInfo } from "../types";
import type {
  ChatState,
  Entry,
  AssistantEntry,
  ContextState,
} from "../state";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
}

export function useMessageHandling(
  setState: (updater: (prev: ChatState) => ChatState) => void,
  textareaRef: preact.RefObject<HTMLTextAreaElement>,
  vscode: VsCodeApi,
) {
  function handleMessage(prev: ChatState, msg: ExtensionToWebview): ChatState {
    const entries = [...prev.entries];
    const lastEntry = entries[entries.length - 1];
    const assistant =
      lastEntry?.role === "assistant"
        ? { ...lastEntry, turns: [...lastEntry.turns] }
        : null;

    if (assistant) {
      entries[entries.length - 1] = assistant;
    }

    function ensureTurn() {
      if (assistant && assistant.turns.length === 0) {
        assistant.turns.push({ text: "", tools: [] });
      }
    }

    switch (msg.type) {
      case "init": {
        return {
          ...prev,
          contextState: msg.hasContext
            ? ("ready" as ContextState)
            : prev.contextState,
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
        };
      }
      case "restore": {
        return {
          ...prev,
          entries: msg.entries,
          isStreaming: false,
          activeTool: null,
          contextState: msg.hasContext
            ? ("ready" as ContextState)
            : ("none" as ContextState),
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
        };
      }
      case "sessions-updated": {
        return {
          ...prev,
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
        };
      }
      case "inject-user": {
        const injected: Entry[] = [
          ...entries,
          { role: "user", content: msg.text },
          { role: "assistant", turns: [] },
        ];
        return {
          ...prev,
          entries: injected,
          isStreaming: true,
          activeTool: null,
          contextState: "pending" as ContextState,
        };
      }
      case "turn-start": {
        if (assistant) {
          assistant.turns.push({ text: "", tools: [] });
        }
        return { ...prev, entries, activeTool: null };
      }
      case "token": {
        if (assistant) {
          ensureTurn();
          const turn = { ...assistant.turns[assistant.turns.length - 1] };
          turn.text += msg.text;
          assistant.turns[assistant.turns.length - 1] = turn;
        }
        return { ...prev, entries };
      }
      case "tool-start": {
        if (assistant) {
          ensureTurn();
          const turn = { ...assistant.turns[assistant.turns.length - 1] };
          turn.tools = [
            ...turn.tools,
            {
              id: msg.toolId,
              name: msg.tool,
              description: msg.description,
              status: "pending",
            },
          ];
          assistant.turns[assistant.turns.length - 1] = turn;
        }
        return { ...prev, entries, activeTool: msg.tool };
      }
      case "tool-end": {
        if (assistant && assistant.turns.length > 0) {
          const turn = { ...assistant.turns[assistant.turns.length - 1] };
          turn.tools = turn.tools.map((t) =>
            t.id === msg.toolId
              ? {
                  ...t,
                  status: msg.isError
                    ? ("error" as const)
                    : ("success" as const),
                }
              : t,
          );
          assistant.turns[assistant.turns.length - 1] = turn;
        }
        return {
          ...prev,
          entries,
          activeTool: prev.activeTool === msg.tool ? null : prev.activeTool,
        };
      }
      case "context-updated": {
        return { ...prev, contextState: "ready" as ContextState };
      }
      case "set-file-context": {
        return {
          ...prev,
          fileContext: msg.filePath
            ? { filePath: msg.filePath, cursorLine: msg.cursorLine }
            : null,
        };
      }
      case "done": {
        return { ...prev, entries, isStreaming: false, activeTool: null };
      }
      case "error": {
        if (assistant) {
          ensureTurn();
          const turn = { ...assistant.turns[assistant.turns.length - 1] };
          turn.text += `\n\nError: ${msg.text}`;
          assistant.turns[assistant.turns.length - 1] = turn;
        }
        return { ...prev, entries };
      }
      default:
        return prev;
    }
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as ExtensionToWebview;
      if (msg.type === "focus") {
        textareaRef.current?.focus();
        return;
      }
      setState((prev) => handleMessage(prev, msg));
    }
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [handleMessage, textareaRef, vscode, setState]);
}
