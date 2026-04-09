import { useRef, useEffect } from "preact/hooks";
import { Logo } from "./Logo";
import { type Entry } from "./state";
import { renderMarkdown, CLIPBOARD_ICON, CHECK_ICON } from "./markdown";
import { AssistantMessage } from "./AssistantMessage";
import { SessionMenu } from "./SessionMenu";
import { useAppState } from "./useAppState";
import { useMessageHandling } from "./useMessageHandling";
import { useMessageListScroll } from "./useMessageListScroll";
import { useTextareaAutoResize } from "./useTextareaAutoResize";
import {
  SEND_ICON,
  STOP_ICON,
  NEW_SESSION_ICON,
  copyCodeWithFeedback,
  handleFilePathClick,
  handleCommandClick,
} from "./utils";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
}

interface AppProps {
  vscode: VsCodeApi;
}

export function App({ vscode }: AppProps) {
  const [state, setState] = useAppState(vscode);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  useMessageHandling(setState, textareaRef, vscode);
  const { userScrolledUp, onScroll } = useMessageListScroll(messageListRef);
  const autoResize = useTextareaAutoResize(textareaRef);

  useEffect(() => {
    if (!state.isStreaming) {
      textareaRef.current?.focus();
    }
  }, [state.isStreaming]);

  function send(text: string) {
    const newEntries: Entry[] = [
      ...state.entries,
      { role: "user", content: text },
      { role: "assistant", turns: [] },
    ];
    setState({
      ...state,
      entries: newEntries,
      isStreaming: true,
      activeTool: null,
      contextState: "pending",
    });
    userScrolledUp.current = false;
    vscode.postMessage({ type: "send", text });
  }

  function newSession() {
    const currentEntries = state.entries;
    setState((prev) => ({
      ...prev,
      entries: [],
      isStreaming: false,
      activeTool: null,
    }));
    vscode.postMessage({ type: "new-session", currentEntries });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function switchToSession(id: string) {
    if (id === state.activeSessionId) return;
    vscode.postMessage({
      type: "switch-session",
      id,
      currentEntries: state.entries,
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (state.isStreaming) return;
      const text = textareaRef.current?.value.trim();
      if (!text) return;
      textareaRef.current!.value = "";
      autoResize();
      send(text);
    }
    if (e.key === "Escape" && state.isStreaming) {
      vscode.postMessage({ type: "cancel" });
    }
  }

  function onClickSend() {
    if (state.isStreaming) {
      vscode.postMessage({ type: "cancel" });
      return;
    }
    const text = textareaRef.current?.value.trim();
    if (!text) return;
    textareaRef.current!.value = "";
    autoResize();
    send(text);
  }

  function onMessageListClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const btn = target.closest("button");
    const codePath = target.closest(".code-path") as HTMLElement | null;

    if (codePath) {
      handleFilePathClick(codePath, vscode.postMessage.bind(vscode));
      return;
    }

    if (btn?.classList.contains("code-copy-btn")) {
      const code = btn.dataset.code ?? "";
      copyCodeWithFeedback(
        code,
        btn as HTMLButtonElement,
        CHECK_ICON,
        CLIPBOARD_ICON,
      );
      return;
    }

    if (btn?.classList.contains("code-run-btn")) {
      handleCommandClick(
        btn as HTMLButtonElement,
        vscode.postMessage.bind(vscode),
      );
      return;
    }
  }

  const isEmpty = state.entries.length === 0;
  const hasSessions = state.sessions.length > 0;

  return (
    <>
      <div
        class="message-list"
        ref={messageListRef}
        onScroll={onScroll}
        onClick={onMessageListClick}
      >
        {isEmpty ? (
          <div class="empty-state">
            <Logo />
            <div class="empty-state-text">
              Research your codebase and the web. Findings are shared with the
              inline agent.
            </div>
          </div>
        ) : (
          <>
            {state.entries.map((entry, i) => {
              const isLast = i === state.entries.length - 1;
              if (entry.role === "user") {
                return <UserMessage key={i} content={entry.content} />;
              }
              return (
                <AssistantMessage
                  key={i}
                  entry={entry}
                  isStreaming={isLast && state.isStreaming}
                  activeTool={isLast ? state.activeTool : null}
                />
              );
            })}
            <div class="message-list-spacer" />
          </>
        )}
      </div>

      <div class="input-area">
        <div class="input-area-inner">
          <div class="input-wrapper">
            <textarea
              ref={textareaRef}
              placeholder="Ask about your codebase or the web..."
              rows={1}
              onInput={autoResize}
              onKeyDown={onKeyDown}
            />
            <div class="input-toolbar">
              <button
                class="reset-btn"
                title="New session"
                disabled={state.isStreaming || isEmpty}
                onClick={newSession}
                dangerouslySetInnerHTML={{ __html: NEW_SESSION_ICON }}
              />
              {hasSessions && state.sessions.length > 1 && (
                <SessionMenu
                  sessions={state.sessions}
                  activeSessionId={state.activeSessionId}
                  disabled={state.isStreaming}
                  onSwitch={switchToSession}
                />
              )}
              <div style={{ flex: 1 }} />
              <button
                class="send-btn"
                title={state.isStreaming ? "Stop (Escape)" : "Send (Enter)"}
                onClick={onClickSend}
                dangerouslySetInnerHTML={{
                  __html: state.isStreaming ? STOP_ICON : SEND_ICON,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div
      class="message message-user"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
}
