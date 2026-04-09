import { useState, useEffect } from "preact/hooks";
import type { ChatState } from "./state";
import { createInitialState } from "./state";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
}

export function useAppState(vscode: VsCodeApi) {
  const [state, setState] = useState<ChatState>(() =>
    createInitialState(vscode.getState()),
  );

  useEffect(() => {
    if (!state.isStreaming) {
      vscode.setState({
        entries: state.entries,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      });
    }
  }, [
    state.entries,
    state.isStreaming,
    state.sessions,
    state.activeSessionId,
    vscode,
  ]);

  return [state, setState] as const;
}
