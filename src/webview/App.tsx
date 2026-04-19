import { useRef, useEffect } from "preact/hooks";
import { Logo } from "./Logo";
import { type Entry, countTurns, serializeConversation } from "./state";
import { CLIPBOARD_ICON, CHECK_ICON } from "./markdown";
import { AssistantMessage } from "./AssistantMessage";
import { SessionMenu } from "./SessionMenu";
import { StatsBar } from "./StatsBar";
import { Breakdown, StepDetail } from "./Breakdown";
import { UserMessage } from "./UserMessage";
import { useAppState } from "./useAppState";
import { useMessageHandling } from "./useMessageHandling";
import { useMessageListScroll } from "./useMessageListScroll";
import { useTextareaAutoResize } from "./useTextareaAutoResize";
import { useStickyUserMessage } from "./useStickyUserMessage";
import { useCodeActions } from "./useCodeActions";
import {
  STOP_ICON,
  NEW_SESSION_ICON,
  FILE_ICON,
  copyCodeWithFeedback,
  handleCommandClick,
  REVIEW_ICON,
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
  const stepListRef = useRef<HTMLDivElement>(null);
  const pinnedQueryRef = useRef<HTMLDivElement>(null);

  useMessageHandling(setState, textareaRef, vscode);
  const { userScrolledUp, onScroll } = useMessageListScroll(messageListRef);
  const { registerUserMessage } = useStickyUserMessage(
    messageListRef,
    pinnedQueryRef,
  );
  const autoResize = useTextareaAutoResize(textareaRef);
  useCodeActions(messageListRef, pinnedQueryRef, state.isStreaming);

  const wasStreaming = useRef(false);
  useEffect(() => {
    // Only focus when streaming ends, not on initial render
    if (wasStreaming.current && !state.isStreaming) {
      textareaRef.current?.focus();
    }
    wasStreaming.current = state.isStreaming;
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
      selectedStepIndex: null,
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

  function onClickStop() {
    vscode.postMessage({ type: "cancel" });
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
        const hasLine =
          colonIdx > 0 && /^\d+$/.test(pathWithLine.slice(colonIdx + 1));
        const filePath = hasLine
          ? pathWithLine.slice(0, colonIdx)
          : pathWithLine;
        const line = hasLine
          ? parseInt(pathWithLine.slice(colonIdx + 1), 10)
          : undefined;
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

  function onSelectStep(index: number | null) {
    setState((prev) => ({ ...prev, selectedStepIndex: index }));

    vscode.postMessage({ type: "select-step", index });

    if (index === null) {
      userScrolledUp.current = false;
      textareaRef.current?.focus();
      return;
    }

    // Scroll step detail to top
    requestAnimationFrame(() => {
      if (stepListRef.current) {
        stepListRef.current.scrollTop = 0;
      }
    });

    const step = state.breakdownSteps[index];
    vscode.postMessage({
      type: "open-file",
      path: step.filePath,
      line: step.lineHint,
    });
  }

  function onApplyStep(index: number) {
    vscode.postMessage({ type: "apply-step", index });
  }

  const isEmpty = state.entries.length === 0;
  const hasSessions = state.sessions.length > 0;
  const selectedStep =
    state.selectedStepIndex !== null
      ? state.breakdownSteps[state.selectedStepIndex]
      : null;

  return (
    <>
      {state.breakdownSteps.length > 0 && (
        <Breakdown
          steps={state.breakdownSteps}
          selectedIndex={state.selectedStepIndex}
          stepStatuses={state.stepStatuses}
          onSelect={onSelectStep}
          onApply={onApplyStep}
        />
      )}
      <div class="message-list-wrapper">
        <div
          ref={pinnedQueryRef}
          class="pinned-query message message-user"
          style={{ display: "none" }}
        />
        {selectedStep ? (
          <div
            ref={stepListRef}
            class="message-list"
            onClick={onMessageListClick}
          >
            <StepDetail
              step={selectedStep}
              stepIndex={state.selectedStepIndex!}
              stepStatus={state.stepStatuses.get(state.selectedStepIndex!)}
              onApply={onApplyStep}
            />
          </div>
        ) : (
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
                  Your thinking partner — explore code, break down work, get
                  your changes reviewed. Context is shared with the inline
                  agent.
                </div>
              </div>
            ) : (
              <>
                {state.entries.map((entry, i) => {
                  const isLast = i === state.entries.length - 1;
                  if (entry.role === "user") {
                    return (
                      <UserMessage
                        key={i}
                        index={i}
                        content={entry.content}
                        registerRef={registerUserMessage}
                      />
                    );
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
                {!state.isStreaming && (
                  <StatsBar
                    numTurns={countTurns(state.entries)}
                    conversationText={serializeConversation(state.entries)}
                  />
                )}
                <div class="message-list-spacer" />
              </>
            )}
          </div>
        )}
      </div>

      <div class="input-area">
        <div class="input-area-inner">
          <div class="input-wrapper">
            {state.fileContext && (
              <div class="file-context-badge">
                <span
                  class="file-context-icon"
                  dangerouslySetInnerHTML={{ __html: FILE_ICON }}
                />
                <span class="file-context-path">
                  {state.fileContext.selection
                    ? `${state.fileContext.filePath} (selection)`
                    : state.fileContext.cursorLine <= 1
                      ? state.fileContext.filePath
                      : `${state.fileContext.filePath}:${state.fileContext.cursorLine}`}
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              placeholder={
                state.isStreaming
                  ? "Send a follow-up message..."
                  : "What do you want to understand or break down?"
              }
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
              {state.breakdownSteps.length > 0 && (
                <button
                  class="reset-btn review-btn"
                  title="Review Breakdown"
                  disabled={state.isStreaming}
                  onClick={() =>
                    send(
                      "Review the changes I made for the current breakdown steps. Check if I followed the guidance correctly and suggest any improvements.",
                    )
                  }
                  dangerouslySetInnerHTML={{ __html: REVIEW_ICON }}
                />
              )}
              <div style={{ flex: 1 }} />
              {state.isStreaming && (
                <button
                  class="send-btn"
                  title="Stop (Escape)"
                  onClick={onClickStop}
                  dangerouslySetInnerHTML={{ __html: STOP_ICON }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
