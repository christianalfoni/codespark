import { useRef, useEffect } from "preact/hooks";
import { Logo } from "./Logo";
import { type Entry, serializeConversation } from "./state";
import { CLIPBOARD_ICON, CHECK_ICON } from "./markdown";
import { AssistantMessage } from "./AssistantMessage";
import { SessionMenu } from "./SessionMenu";
import { StatsBar } from "./StatsBar";
import { Breakdown } from "./Breakdown";
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
  BOLT_ICON,
  copyCodeWithFeedback,
  formatTokens,
  handleCommandClick,
  PR_ICON,
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
  const pinnedQueryRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  useMessageHandling(setState, textareaRef, vscode);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const el = (e.target as HTMLElement)?.closest?.("[data-tooltip]");
      if (el) el.classList.add("tooltip-suppressed");
    }
    function onMouseOut(e: MouseEvent) {
      const el = (e.target as HTMLElement)?.closest?.("[data-tooltip]");
      if (el && !el.contains(e.relatedTarget as Node)) {
        el.classList.remove("tooltip-suppressed");
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseout", onMouseOut);
    };
  }, []);

  const { userScrolledUp, onScroll } = useMessageListScroll(messageListRef);

  const lastEntry = state.entries[state.entries.length - 1];
  const activeUserIndex =
    state.isStreaming && lastEntry?.role === "assistant"
      ? state.entries.length - 2
      : -1;

  const { registerUserMessage } = useStickyUserMessage(
    messageListRef,
    pinnedQueryRef,
    undefined,
    activeUserIndex,
  );
  const autoResize = useTextareaAutoResize(textareaRef);
  useCodeActions(messageListRef, pinnedQueryRef, state.isStreaming, "conversation");

  // Keep message list bottom padding in sync with the input area height
  useEffect(() => {
    const inputEl = inputAreaRef.current;
    if (!inputEl) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      document.documentElement.style.setProperty(
        "--input-area-height",
        `${height}px`,
      );
    });
    observer.observe(inputEl);
    return () => observer.disconnect();
  }, []);

  const wasStreaming = useRef(false);
  useEffect(() => {
    // Only focus when streaming ends, not on initial render
    if (wasStreaming.current && !state.isStreaming) {
      textareaRef.current?.focus();
    }
    wasStreaming.current = state.isStreaming;
  }, [state.isStreaming]);

  function send(text: string, opts?: { actionLabel?: string; editMode?: boolean }) {
    const fileRef = state.fileContext ?? undefined;
    const userEntry: Entry = {
      role: "user",
      content: text,
      ...(opts?.actionLabel ? { actionLabel: opts.actionLabel } : {}),
      ...(fileRef ? { fileRef } : {}),
    };
    const newEntries: Entry[] = [
      ...state.entries,
      userEntry,
      { role: "assistant", turns: [] },
    ];
    setState({ ...state, entries: newEntries, isStreaming: true, activeTool: null, contextState: "pending", fileContext: null });
    userScrolledUp.current = false;
    vscode.postMessage({ type: "send", text, editMode: opts?.editMode });
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

  function onOpenStep(index: number) {
    const step = state.breakdownSteps[index];
    if (!step) return;
    vscode.postMessage({ type: "open-file", path: step.filePath, line: step.lineHint });
  }

  function onApplySteps() {
    const steps = state.breakdownSteps;
    if (steps.length === 0) return;
    const list = steps
      .map(s => `- ${s.keyword ?? "MODIFY"} ${s.filePath}${s.lineHint ? `:${s.lineHint}` : ""}: ${s.title}`)
      .join("\n");
    const prompt = `[EDIT MODE ACTIVE]\n\nApply the following intended changes:\n\n${list}`;
    send(prompt, { actionLabel: "Apply changes", editMode: true });
  }

  const isEmpty = state.entries.length === 0;
  const hasSessions = state.sessions.length > 0;

  const usageTotalIn =
    state.usage.totalInputTokens +
    state.usage.totalCacheReadTokens +
    state.usage.totalCacheCreationTokens;
  const usageContext = usageTotalIn + state.usage.lastOutputTokens;
  const usageOut = state.usage.totalOutputTokens;
  const hasUsage = usageContext > 0;

  return (
    <>
      <div class="message-list-wrapper">
        <div
          ref={pinnedQueryRef}
          class="pinned-query message message-user"
          style={{ display: "none" }}
        />
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
                your changes reviewed.
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
                      fileRef={entry.fileRef}
                      actionLabel={entry.actionLabel}
                      registerRef={registerUserMessage}
                      isActive={i === activeUserIndex}
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
              <div class="message-list-spacer" />
            </>
          )}
        </div>
      </div>

      <div ref={inputAreaRef} class="input-area">
        <div class="input-area-inner">
          <div class="input-wrapper">
            {state.breakdownSteps.length > 0 && (
              <Breakdown
                steps={state.breakdownSteps}
                onOpen={onOpenStep}
              />
            )}
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
              onFocus={() => vscode.postMessage({ type: "input-focus", focused: true })}
              onBlur={() => vscode.postMessage({ type: "input-focus", focused: false })}
            />
            <div class="input-toolbar">
              <div class="input-toolbar-left">
                <button
                  class="reset-btn"
                  data-tooltip="New session"
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
                {!isEmpty && (
                  <button
                    ref={copyBtnRef}
                    class="reset-btn"
                    data-tooltip="Copy conversation"
                    disabled={state.isStreaming}
                    onClick={() => {
                      if (copyBtnRef.current) {
                        copyCodeWithFeedback(
                          serializeConversation(state.entries),
                          copyBtnRef.current,
                          CHECK_ICON,
                          CLIPBOARD_ICON,
                        );
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: CLIPBOARD_ICON }}
                  />
                )}
                {state.entries.length > 0 && <button
                  class="reset-btn review-btn"
                  data-tooltip="Create PR"
                  disabled={state.isStreaming}
                  onClick={() => {
                    send(
                      "Create a PR for the current changes. Use git_log and git_diff to review what has been committed, then call create_pr with the PR title and a description written in the Agent Contribution Report format.",
                      { actionLabel: "Create PR" },
                    );
                  }}
                  dangerouslySetInnerHTML={{ __html: PR_ICON }}
                />}
                {state.breakdownSteps.length > 0 && (
                  <button
                    class="reset-btn"
                    data-tooltip="Apply changes"
                    disabled={state.isStreaming}
                    onClick={onApplySteps}
                    dangerouslySetInnerHTML={{ __html: BOLT_ICON }}
                  />
                )}
              </div>
              <div class="input-toolbar-right">
                {hasUsage && (
                  <span class="toolbar-stats toolbar-stats--hoverable">
                    {formatTokens(usageContext)} tokens{state.usage.hadThinking ? " · extended thinking" : ""}
                    <span class="toolbar-stats__detail">
                      (in: {formatTokens(usageContext - usageOut)}, out: {formatTokens(usageOut)})
                    </span>
                  </span>
                )}
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
      </div>
    </>
  );
}
