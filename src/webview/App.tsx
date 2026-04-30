import { useRef, useEffect } from "preact/hooks";
import { Logo } from "./Logo";
import { type Entry, serializeConversation } from "./state";
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
  BOLT_ICON,
  copyCodeWithFeedback,
  formatTokens,
  handleCommandClick,
  REVIEW_ICON,
  STACK_ICON,
} from "./utils";

const SPINNER_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" class="step-apply-spin"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z" opacity="0.25"/><path d="M8 1a7 7 0 0 1 7 7h-1.5A5.5 5.5 0 0 0 8 2.5V1z"/></svg>`;

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
  const stepPinnedQueryRef = useRef<HTMLDivElement>(null);
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

  const { userScrolledUp, onScroll } = useMessageListScroll(messageListRef, stepListRef);

  const lastEntry = state.entries[state.entries.length - 1];
  const activeUserIndex =
    state.isStreaming && lastEntry?.role === "assistant"
      ? state.entries.length - 2
      : -1;

  const { registerUserMessage } = useStickyUserMessage(
    messageListRef,
    pinnedQueryRef,
    state.selectedStepIndex,
    activeUserIndex,
  );
  const { registerUserMessage: registerStepUserMessage } = useStickyUserMessage(
    stepListRef,
    stepPinnedQueryRef,
    state.selectedStepIndex,
    activeUserIndex,
  );
  const autoResize = useTextareaAutoResize(textareaRef);
  useCodeActions(messageListRef, pinnedQueryRef, state.isStreaming, state.selectedStepIndex === null ? "conversation" : null);
  useCodeActions(stepListRef, stepPinnedQueryRef, state.isStreaming, state.selectedStepIndex);

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

  function send(text: string, opts?: { skipStepRef?: boolean; actionLabel?: string }) {
    const step =
      !opts?.skipStepRef && state.selectedStepIndex !== null
        ? state.breakdownSteps[state.selectedStepIndex]
        : null;
    const fileRef = state.fileContext ?? undefined;
    const userEntry: Entry = step
      ? { role: "user", content: text, stepRef: { stepIndex: state.selectedStepIndex!, title: step.title, filePath: step.filePath }, ...(opts?.actionLabel ? { actionLabel: opts.actionLabel } : {}), ...(fileRef ? { fileRef } : {}) }
      : { role: "user", content: text, ...(opts?.actionLabel ? { actionLabel: opts.actionLabel } : {}), ...(fileRef ? { fileRef } : {}) };
    const newEntries: Entry[] = [
      ...state.entries,
      userEntry,
      { role: "assistant", turns: [] },
    ];
    setState({
      ...state,
      entries: newEntries,
      isStreaming: true,
      activeTool: null,
      contextState: "pending",
      fileContext: null,
      ...(opts?.skipStepRef ? { selectedStepIndex: null } : {}),
    });
    userScrolledUp.current = false;
    const msg: any = { type: "send", text };
    if (!opts?.skipStepRef && state.selectedStepIndex !== null) {
      msg.stepIndex = state.selectedStepIndex;
    }
    vscode.postMessage(msg);
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
    textareaRef.current?.focus();

    if (index === null) {
      userScrolledUp.current = false;
      return;
    }

    // Scroll step detail to top
    requestAnimationFrame(() => {
      if (stepListRef.current) {
        stepListRef.current.scrollTop = 0;
      }
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
        {selectedStep ? (
          <>
            <div
              ref={stepPinnedQueryRef}
              class="pinned-query message message-user"
              style={{ display: "none" }}
            />
            <div
              ref={stepListRef}
              class="message-list"
              onScroll={onScroll}
              onClick={onMessageListClick}
            >
              <StepDetail
                step={selectedStep}
                stepIndex={state.selectedStepIndex!}
                stepStatus={state.stepStatuses.get(state.selectedStepIndex!)}
                entries={state.entries}
                isStreaming={state.isStreaming}
                activeTool={state.activeTool}
                registerUserMessage={registerStepUserMessage}
                activeUserIndex={activeUserIndex}
              />
            </div>
          </>
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
                        stepRef={entry.stepRef}
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
        )}
      </div>

      <div ref={inputAreaRef} class="input-area">
        <div class="input-area-inner">
          <div class="input-wrapper">
            {state.breakdownSteps.length > 0 && (
              <Breakdown
                steps={state.breakdownSteps}
                selectedIndex={state.selectedStepIndex}
                stepStatuses={state.stepStatuses}
                onSelect={onSelectStep}
                onApply={onApplyStep}
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
                {state.breakdownSteps.length > 0 && (
                  <>
                    {state.features.stackedCommitsEnabled && (
                      <button
                        class="reset-btn review-btn"
                        data-tooltip="Create stacked commits from breakdown"
                        disabled={state.isStreaming}
                        onClick={() => {
                          onSelectStep(null);
                          send(
                            "Create stacked commits for my current breakdown. Call git_status to see all uncommitted changes, then use the breakdown steps as a guide to group those files into logical commits — multiple steps may map to the same file, and a step may involve files not listed in its breakdown entry. Call create_stacked_commits with an ordered list of commits, each specifying which files to stage. Commit messages should be in the form 'step-title: short summary'.",
                            { skipStepRef: true, actionLabel: "Stack commits" },
                          );
                        }}
                        dangerouslySetInnerHTML={{ __html: STACK_ICON }}
                      />
                    )}
                    <button
                      class="reset-btn review-btn"
                      data-tooltip="Review breakdown"
                      disabled={state.isStreaming}
                      onClick={() => {
                        onSelectStep(null);
                        send(
                          "Review the changes I made for the current breakdown steps. Check if I followed the guidance correctly and suggest any improvements.",
                          { skipStepRef: true, actionLabel: "Review breakdown" },
                        );
                      }}
                      dangerouslySetInnerHTML={{ __html: REVIEW_ICON }}
                    />
                    {state.selectedStepIndex !== null && (
                      <button
                        class="reset-btn review-btn"
                        data-tooltip={state.stepStatuses.get(state.selectedStepIndex)?.status === "applying" ? "Applying…" : "Fast Edit — apply this step"}
                        disabled={state.isStreaming || state.stepStatuses.get(state.selectedStepIndex)?.status === "applying"}
                        onClick={() => onApplyStep(state.selectedStepIndex!)}
                        dangerouslySetInnerHTML={{ __html: state.stepStatuses.get(state.selectedStepIndex)?.status === "applying" ? SPINNER_ICON : BOLT_ICON }}
                      />
                    )}
                  </>
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
