import { useRef, useEffect, useState } from "preact/hooks";
import { Logo } from "./Logo";
import { type Entry } from "./state";
import {
  renderMarkdown,
  CLIPBOARD_ICON,
  CHECK_ICON,
} from "./markdown";
import { AssistantMessage } from "./AssistantMessage";
import { SessionMenu } from "./SessionMenu";
import { SuggestionPanel } from "./SuggestionPanel";
import { useAppState } from "./useAppState";
import { useMessageHandling } from "./useMessageHandling";
import { useMessageListScroll } from "./useMessageListScroll";
import { useTextareaAutoResize } from "./useTextareaAutoResize";
import {
  SEND_ICON,
  STOP_ICON,
  NEW_SESSION_ICON,
  REVIEW_ICON,
  copyCodeWithFeedback,
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
      fileContext: null,
    });
    userScrolledUp.current = false;
    vscode.postMessage({ type: "send", text });
  }

  function reviewEdits() {
    vscode.postMessage({ type: "review-edits" });
  }

  function newSession() {
    const currentEntries = state.entries;
    setState((prev) => ({
      ...prev,
      entries: [],
      isStreaming: false,
      activeTool: null,
      fileContext: null,
    }));
    vscode.postMessage({ type: "new-session", currentEntries });
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.value = "";
        textareaRef.current.focus();
      }
    }, 0);
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

    const anchor = target.closest("a") as HTMLAnchorElement | null;
    if (anchor) {
      e.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("vscode://file/")) {
        const pathWithLine = href.slice("vscode://file".length);
        const colonIdx = pathWithLine.lastIndexOf(":");
        const hasLine = colonIdx > 0 && /^\d+$/.test(pathWithLine.slice(colonIdx + 1));
        const filePath = hasLine ? pathWithLine.slice(0, colonIdx) : pathWithLine;
        const line = hasLine ? parseInt(pathWithLine.slice(colonIdx + 1), 10) : undefined;
        postMessage({ type: "open-file", path: filePath, line });
      }
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
            {state.isReviewMode && state.reviewSuggestions.length > 0 && (
              <SuggestionPanel
                suggestions={state.reviewSuggestions}
                vscode={vscode}
              />
            )}
            <textarea
              ref={textareaRef}
              placeholder="Do some research to learn and get suggestions..."
              rows={1}
              onInput={autoResize}
              onKeyDown={onKeyDown}
            />
            <div class="input-toolbar">
              <button
                class="reset-btn"
                title="New session"
                disabled={state.isStreaming}
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
              {state.editLogCount > 0 && (
                <button
                  class="review-btn"
                  title="Review inline edits"
                  disabled={state.isStreaming || state.isReviewMode}
                  onClick={reviewEdits}
                >
                  <span dangerouslySetInnerHTML={{ __html: REVIEW_ICON }} />
                  <span class="review-badge">{state.editLogCount}</span>
                </button>
              )}
              <div style={{ flex: 1 }} />
              {state.fileContext && (
                <div class="file-context-badge">
                  <span class="file-context-path">
                    {state.fileContext.selection
                      ? `${state.fileContext.filePath} (selection)`
                      : `${state.fileContext.filePath}:${state.fileContext.cursorLine}`}
                  </span>
                </div>
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

const MAX_LINES = 3;
const MAX_CHARS = 200;

function truncateContent(text: string): {
  truncated: string;
  isTruncated: boolean;
} {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) {
    return { truncated: text, isTruncated: false };
  }
  let result = lines.slice(0, MAX_LINES).join("\n");
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS);
  }
  return { truncated: result.trimEnd() + "…", isTruncated: true };
}

function UserMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const { truncated, isTruncated } = truncateContent(content);
  const display = expanded ? content : truncated;

  return (
    <div
      class="message message-user"
      onClick={isTruncated ? () => setExpanded((e) => !e) : undefined}
      style={isTruncated ? { cursor: "pointer" } : undefined}
    >
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(display) }} />
      {isTruncated && (
        <span
          class="message-user__toggle"
          dangerouslySetInnerHTML={{
            __html: expanded
              ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5.5l-4.5 4 .7.8L8 6.9l3.8 3.4.7-.8z"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l4.5-4-.7-.8L8 9.1 4.2 5.7l-.7.8z"/></svg>',
          }}
        />
      )}
    </div>
  );
}
