import { useEffect } from "preact/hooks";
import type * as preact from "preact";
import type { ExtensionToWebview, SessionInfo } from "./types";
import type {
  ChatState,
  Entry,
  AssistantEntry,
  ContextState,
} from "./state";

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
        const sessionChanged = msg.activeSessionId !== prev.activeSessionId;
        const zeroUsage = {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          lastOutputTokens: 0,
        };
        return {
          ...prev,
          contextState: msg.hasContext
            ? ("ready" as ContextState)
            : prev.contextState,
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
          features: msg.features ?? prev.features,
          ...(sessionChanged ? { usage: zeroUsage, inlineUsage: zeroUsage } : {}),
        };
      }
      case "restore": {
        const sessionChanged = msg.activeSessionId !== prev.activeSessionId;
        const zeroUsage = {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          lastOutputTokens: 0,
        };
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
          features: msg.features ?? prev.features,
          ...(sessionChanged ? { usage: zeroUsage, inlineUsage: zeroUsage } : {}),
        };
      }
      case "sessions-updated": {
        const sessionChanged = msg.activeSessionId !== prev.activeSessionId;
        const zeroUsage = {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          lastOutputTokens: 0,
        };
        return {
          ...prev,
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
          ...(sessionChanged ? { usage: zeroUsage, inlineUsage: zeroUsage } : {}),
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
        return { ...prev, entries, isStreaming: true, activeTool: null };
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
                  description: msg.description ?? t.description,
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
            ? { filePath: msg.filePath, cursorLine: msg.cursorLine, selection: msg.selection ?? undefined }
            : null,
        };
      }
      case "breakdown": {
        return {
          ...prev,
          breakdownSteps: msg.steps,
          selectedStepIndex: null,
          stepStatuses: new Map(),
        };
      }
      case "step-status": {
        const newStatuses = new Map(prev.stepStatuses);
        newStatuses.set(msg.index, { status: msg.status, text: msg.text });
        return { ...prev, stepStatuses: newStatuses };
      }
      case "usage": {
        if (msg.source === "inline") {
          // Inline edits are independent invocations — accumulate everything so
          // the stats bar shows total tokens consumed across all fast edits.
          return {
            ...prev,
            inlineUsage: {
              totalInputTokens: prev.inlineUsage.totalInputTokens + msg.inputTokens,
              totalCacheReadTokens: prev.inlineUsage.totalCacheReadTokens + msg.cacheReadInputTokens,
              totalCacheCreationTokens: prev.inlineUsage.totalCacheCreationTokens + msg.cacheCreationInputTokens,
              totalOutputTokens: prev.inlineUsage.totalOutputTokens + msg.outputTokens,
              lastOutputTokens: msg.outputTokens,
            },
          };
        }
        // One usage event is emitted per assistant turn (at result time), carrying:
        //   inputTokens / cacheRead / cacheCreation  →  from the LAST message_start
        //     of that turn. This is the true context window size fed as input.
        //     REPLACE (not accumulate): each turn's message_start already includes
        //     all previous turns' outputs baked in as context, so the value grows
        //     naturally without us summing it.
        //   outputTokens  →  from the LAST message_delta of that turn (final text
        //     response only, not intermediate tool_use output). ACCUMULATE across
        //     turns to track total tokens generated this session.
        //   lastOutputTokens  →  same as outputTokens but NOT accumulated — always
        //     the most recent turn's output, used by StatsBar to compute full context.
        return {
          ...prev,
          usage: {
            totalInputTokens: msg.inputTokens,
            totalCacheReadTokens: msg.cacheReadInputTokens,
            totalCacheCreationTokens: msg.cacheCreationInputTokens,
            totalOutputTokens: prev.usage.totalOutputTokens + msg.outputTokens,
            lastOutputTokens: msg.outputTokens,
          },
        };
      }
      case "done": {
        return {
          ...prev,
          entries,
          isStreaming: false,
          activeTool: null,
        };
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
  }, []);
}
