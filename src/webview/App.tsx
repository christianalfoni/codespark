import * as preact from "preact";
import { useRef, useState, useEffect } from "preact/hooks";
import type { ExtensionToWebview } from "./types";
import {
  type ChatState,
  type Entry,
  type AssistantEntry,
  type ToolEntry,
  type ContextState,
  createInitialState,
} from "./state";
import { renderMarkdown, CLIPBOARD_ICON, CHECK_ICON } from "./markdown";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
}

interface AppProps {
  vscode: VsCodeApi;
  logoUri: string;
}

const SEND_ICON = `<svg viewBox="0 0 16 16"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;
const NEW_SESSION_ICON = `<svg viewBox="0 0 16 16"><path d="M14 1H4a1 1 0 0 0-1 1v2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2h1a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-2 13H2V5h10v9zm2-3h-1V4H4V2h10v9z"/></svg>`;

export function App({ vscode, logoUri }: AppProps) {
  const [state, setState] = useState<ChatState>(() =>
    createInitialState(vscode.getState()),
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    if (!state.isStreaming) {
      vscode.setState({ entries: state.entries });
    }
  }, [state.entries, state.isStreaming]);

  useEffect(() => {
    if (messageListRef.current && !userScrolledUp.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  });

  useEffect(() => {
    if (!state.isStreaming) {
      textareaRef.current?.focus();
    }
  }, [state.isStreaming]);

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
        return { ...prev, contextState: msg.hasContext ? "ready" as ContextState : prev.contextState };
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
          turn.tools = [...turn.tools, { name: msg.tool, status: "pending" }];
          assistant.turns[assistant.turns.length - 1] = turn;
        }
        return { ...prev, entries, activeTool: msg.tool };
      }
      case "tool-end": {
        if (assistant && assistant.turns.length > 0) {
          const turn = { ...assistant.turns[assistant.turns.length - 1] };
          turn.tools = turn.tools.map((t) =>
            t.name === msg.tool && t.status === "pending"
              ? { ...t, status: msg.isError ? "error" as const : "success" as const }
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

  function send(text: string) {
    const newEntries: Entry[] = [
      ...state.entries,
      { role: "user", content: text },
      { role: "assistant", turns: [] },
    ];
    setState({ ...state, entries: newEntries, isStreaming: true, activeTool: null, contextState: "pending" });
    userScrolledUp.current = false;
    vscode.postMessage({ type: "send", text });
  }

  function reset() {
    setState({ entries: [], isStreaming: false, activeTool: null, contextState: state.contextState });
    vscode.postMessage({ type: "clear" });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function onScroll() {
    const el = messageListRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUp.current = !atBottom;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (state.isStreaming) return;
      const text = textareaRef.current?.value.trim();
      if (!text) return;
      textareaRef.current!.value = "";
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
    send(text);
  }

  function autoResize() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
  }

  function onMessageListClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const btn = target.closest("button");
    const codePath = target.closest(".code-path") as HTMLElement | null;

    if (codePath) {
      const path = codePath.dataset.path;
      const line = codePath.dataset.line;
      if (path) {
        vscode.postMessage({
          type: "open-file",
          path,
          line: line ? parseInt(line, 10) : undefined,
        });
      }
      return;
    }

    if (btn?.classList.contains("code-copy-btn")) {
      const code = btn.dataset.code ?? "";
      navigator.clipboard.writeText(code);
      btn.innerHTML = CHECK_ICON;
      btn.classList.add("code-copy-btn-copied");
      setTimeout(() => {
        btn.innerHTML = CLIPBOARD_ICON;
        btn.classList.remove("code-copy-btn-copied");
      }, 1000);
      return;
    }

    if (btn?.classList.contains("code-run-btn")) {
      const command = btn.dataset.command ?? "";
      if (command) {
        vscode.postMessage({ type: "run-command", command });
      }
      return;
    }
  }

  const isEmpty = state.entries.length === 0;

  return (
    <>
      <div class="message-list" ref={messageListRef} onScroll={onScroll} onClick={onMessageListClick}>
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
                return (
                  <UserMessage
                    key={i}
                    content={entry.content}
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
              {!isEmpty && (
                <button
                  class="reset-btn"
                  title="New session"
                  disabled={state.isStreaming}
                  onClick={reset}
                  dangerouslySetInnerHTML={{ __html: NEW_SESSION_ICON }}
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
    <div class="message message-user">
      {content}
    </div>
  );
}

function InlineTools({ tools }: { tools: ToolEntry[] }) {
  if (tools.length === 0) return null;
  return (
    <span class="inline-tools">
      {tools.map((t, i) => (
        <span key={i} class="inline-tool">
          <span class={`tool-dot tool-dot-${t.status}`} />
          {t.name}
        </span>
      ))}
    </span>
  );
}

function ContextIndicator({ state }: { state: ContextState }) {
  const cls =
    state === "none"
      ? "context-indicator context-indicator-none"
      : state === "pending"
        ? "context-indicator context-indicator-pending"
        : "context-indicator";

  const sparkle = state === "ready" ? "✦" : "✧";
  const label =
    state === "none"
      ? "No Context"
      : state === "pending"
        ? "Updating Context..."
        : "Context Updated";

  return (
    <span class={cls}>
      <span class="context-sparkle">{sparkle}</span>
      {label}
    </span>
  );
}

function AssistantMessage({
  entry,
  isStreaming,
  activeTool,
}: {
  entry: AssistantEntry;
  isStreaming: boolean;
  activeTool: string | null;
}) {
  const lastTurn = entry.turns[entry.turns.length - 1];
  const currentTurnHasText = lastTurn?.text.trim();

  const elements: preact.JSX.Element[] = [];

  for (let i = 0; i < entry.turns.length; i++) {
    const turn = entry.turns[i];

    if (turn.text.trim()) {
      elements.push(
        <div key={`text-${i}`} class="message message-assistant">
          <div
            class="assistant-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.text) }}
          />
        </div>,
      );
    }

    if (turn.tools.length > 0) {
      elements.push(
        <div key={`tools-${i}`} class="message message-tools">
          <InlineTools tools={turn.tools} />
        </div>,
      );
    }
  }

  if (isStreaming && (activeTool || !currentTurnHasText)) {
    elements.push(
      <div key="thinking" class="message-thinking">
        {activeTool ? `Using ${activeTool}...` : "Thinking..."}
      </div>,
    );
  }

  return <>{elements}</>;
}

function Logo() {
  return (
    <svg class="empty-state-logo" viewBox="0 0 680 320" xmlns="http://www.w3.org/2000/svg">
      {/* Left angle bracket */}
      <polygon
        points="290,80 276,80 232,152 276,224 290,224 246,152"
        class="logo-bracket"
      />
      {/* Right angle bracket */}
      <polygon
        points="390,80 404,80 448,152 404,224 390,224 434,152"
        class="logo-bracket"
      />
      {/* Lightning bolt */}
      <path
        transform="translate(286,98) scale(4.5)"
        d="M14.5 2L5 13h6.5L9.5 22L19 11h-6.5L14.5 2Z"
        class="logo-bolt"
      />
      {/* Wordmark */}
      <text x="340" y="295" class="logo-text">
        Code<tspan class="logo-text-accent">Spark</tspan>
      </text>
    </svg>
  );
}
