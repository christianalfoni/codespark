import * as preact from "preact";
import type { AssistantEntry, ToolEntry } from "./state";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  "read_reference": "Read Reference",
  "mcp__codespark__git_status": "Git Status",
  "mcp__codespark__git_log": "Git Log",
  "mcp__codespark__git_diff": "Git Diff",
  "mcp__codespark__git_blame": "Git Blame",
  "mcp__codespark__edit_file": "Edit File",
  "mcp__codespark__write_file": "Write File",
  "mcp__codespark__move_file": "Move File",
  "mcp__codespark__delete_file": "Delete File",
  "mcp__codespark__update_work_items": "Updating Work Items",
};

interface ToolGroup {
  name: string;
  count: number;
  status: ToolEntry["status"];
  description?: string;
}

function groupTools(tools: ToolEntry[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const t of tools) {
    const existing = groups.find((g) => g.name === t.name);
    if (existing) {
      existing.count++;
      // Aggregate status: pending > error > success
      if (t.status === "pending") existing.status = "pending";
      else if (t.status === "error" && existing.status !== "pending") existing.status = "error";
      // Drop description when grouped
      existing.description = undefined;
    } else {
      groups.push({ name: t.name, count: 1, status: t.status, description: t.description });
    }
  }
  return groups;
}

function InlineTools({ tools }: { tools: ToolEntry[] }) {
  if (tools.length === 0) return null;
  const groups = groupTools(tools);
  return (
    <span class="inline-tools">
      {groups.map((g, i) => (
        <span key={i} class="inline-tool">
          <span class={`tool-dot tool-dot-${g.status}`} />
          <span class="tool-label">
            {TOOL_DISPLAY_NAMES[g.name] ?? g.name}
            {g.description && (
              <span class="tool-description">{g.description}</span>
            )}
          </span>
          {g.count > 1 && (
            <span class="tool-count">({g.count})</span>
          )}
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
