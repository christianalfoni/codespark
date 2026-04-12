import * as preact from "preact";
import type { AssistantEntry, ToolEntry } from "./state";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  mcp__codespark__update_suggestions: "Suggesting edits",
};

function InlineTools({ tools }: { tools: ToolEntry[] }) {
  if (tools.length === 0) return null;
  return (
    <span class="inline-tools">
      {tools.map((t, i) => (
        <span key={i} class="inline-tool">
          <span class={`tool-dot tool-dot-${t.status}`} />
          <span class="tool-label">
            {TOOL_DISPLAY_NAMES[t.name] ?? t.name}
            {t.description && (
              <span class="tool-description">{t.description}</span>
            )}
          </span>
        </span>
      ))}
    </span>
  );
}

export function AssistantMessage({
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
  let pendingTools: ToolEntry[] = [];
  let groupIndex = 0;

  function flushTools() {
    if (pendingTools.length > 0) {
      elements.push(
        <div key={`tools-${groupIndex}`} class="message message-tools">
          <InlineTools tools={pendingTools} />
        </div>,
      );
      pendingTools = [];
      groupIndex++;
    }
  }

  for (let i = 0; i < entry.turns.length; i++) {
    const turn = entry.turns[i];

    if (turn.text.trim()) {
      flushTools();
      elements.push(
        <div key={`text-${i}`} class="message message-assistant">
          <div
            class="assistant-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(prepareForRender(turn.text)) }}
          />
        </div>,
      );
    }

    if (turn.tools.length > 0) {
      pendingTools = [...pendingTools, ...turn.tools];
    }
  }

  flushTools();

  if (isStreaming && (activeTool || !currentTurnHasText)) {
    elements.push(
      <div key="thinking" class="message-thinking">
        Thinking...
      </div>,
    );
  }

  return <>{elements}</>;
}
