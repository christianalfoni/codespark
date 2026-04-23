import type { BreakdownStep } from "./types";
import type { Entry } from "./state";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { FILE_ICON } from "./utils";

const CONVERSATION_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v7A1.5 1.5 0 0 1 13.5 12H9l-3.5 3v-3H2.5A1.5 1.5 0 0 1 1 10.5v-7zM2.5 3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H6v2l2.5-2h5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-11z"/></svg>`;

interface BreakdownProps {
  steps: BreakdownStep[];
  selectedIndex: number | null;
  stepStatuses: Map<number, { status: "applying" | "done" | "error"; text?: string }>;
  onSelect: (index: number | null) => void;
  onApply: (index: number) => void;
}

export function Breakdown({ steps, selectedIndex, onSelect }: BreakdownProps) {
  if (steps.length === 0) return null;

  return (
    <div class="breakdown-panel">
      <div class="breakdown-list">
        {[...steps].reverse().map((step, ri) => {
          const i = steps.length - 1 - ri;
          return (
            <button
              key={i}
              class={`step${selectedIndex === i ? " step-selected" : ""}`}
              onClick={() => onSelect(i)}
            >
              <span class="step-number">{i + 1}</span>
              <span class="step-title">{step.title}</span>
            </button>
          );
        })}
        <button
          class={`step step-conversation${selectedIndex === null ? " step-selected" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span class="step-icon" dangerouslySetInnerHTML={{ __html: CONVERSATION_ICON }} />
          <span class="step-title">Conversation</span>
        </button>
      </div>
    </div>
  );
}

export function StepDetail({ step, stepIndex, stepStatus, entries, isStreaming, activeTool, registerUserMessage, activeUserIndex }: {
  step: BreakdownStep;
  stepIndex: number;
  stepStatus?: { status: "applying" | "done" | "error"; text?: string };
  entries: Entry[];
  isStreaming: boolean;
  activeTool: string | null;
  registerUserMessage: (index: number, el: HTMLElement | null) => void;
  activeUserIndex: number;
}) {
  // Collect entry pairs (user + following assistant) tagged to this step
  const relatedEntries: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.role === "user" && entry.stepRef?.stepIndex === stepIndex) {
      relatedEntries.push(entry);
      // Include the assistant response that follows
      if (i + 1 < entries.length && entries[i + 1].role === "assistant") {
        relatedEntries.push(entries[i + 1]);
      }
    }
  }

  const lastEntryIndex = entries.length - 1;

  return (
    <div class="step-detail">
      {stepStatus?.status === "error" && stepStatus.text && (
        <div class="step-error-message">{stepStatus.text}</div>
      )}
      <div class="step-detail-file">
        <span class="step-detail-file-icon" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
        <span>{step.filePath}{step.lineHint ? `:${step.lineHint}` : ""}</span>
      </div>
      <div
        class="step-detail-content message"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(prepareForRender(step.description)),
        }}
      />
      {relatedEntries.map((entry, i) => {
        const globalIndex = entries.indexOf(entry);
        const isLastGlobal = globalIndex === lastEntryIndex;
        if (entry.role === "user") {
          return (
            <UserMessage
              key={i}
              index={globalIndex}
              content={entry.content}
              registerRef={registerUserMessage}
              isActive={globalIndex === activeUserIndex}
            />
          );
        }
        return (
          <AssistantMessage
            key={i}
            entry={entry}
            isStreaming={isLastGlobal && isStreaming}
            activeTool={isLastGlobal ? activeTool : null}
          />
        );
      })}
    </div>
  );
}
