import { useRef, useEffect } from "preact/hooks";
import type { BreakdownStep } from "./types";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";
import { FILE_ICON, BOLT_ICON } from "./utils";

const CONVERSATION_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v7A1.5 1.5 0 0 1 13.5 12H9l-3.5 3v-3H2.5A1.5 1.5 0 0 1 1 10.5v-7zM2.5 3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H6v2l2.5-2h5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-11z"/></svg>`;
const SPINNER_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" class="step-apply-spin"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z" opacity="0.25"/><path d="M8 1a7 7 0 0 1 7 7h-1.5A5.5 5.5 0 0 0 8 2.5V1z"/></svg>`;

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
        <button
          class={`step step-conversation${selectedIndex === null ? " step-selected" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span class="step-icon" dangerouslySetInnerHTML={{ __html: CONVERSATION_ICON }} />
          <span class="step-title">Conversation</span>
        </button>
        {steps.map((step, i) => (
          <button
            key={i}
            class={`step${selectedIndex === i ? " step-selected" : ""}`}
            onClick={() => onSelect(i)}
          >
            <span class="step-number">{i + 1}</span>
            <span class="step-title">{step.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function StepDetail({ step, stepIndex, stepStatus, onApply }: {
  step: BreakdownStep;
  stepIndex: number;
  stepStatus?: { status: "applying" | "done" | "error"; text?: string };
  onApply: (index: number) => void;
}) {
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const scrollParent = header.closest(".message-list") as HTMLElement | null;
    if (!scrollParent) return;

    function onScroll() {
      header!.classList.toggle(
        "step-detail-header--stuck",
        scrollParent!.scrollTop > 0,
      );
    }

    scrollParent.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scrollParent.removeEventListener("scroll", onScroll);
  }, [step]);

  const isApplying = stepStatus?.status === "applying";

  return (
    <div class="step-detail">
      <div ref={headerRef} class="step-detail-header message-user">
        <span class="step-detail-icon" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
        <span>{step.filePath}{step.lineHint ? `:${step.lineHint}` : ""}</span>
        <button
          class="send-btn step-apply-btn"
          title={isApplying ? "Applying..." : "Apply this step"}
          disabled={isApplying}
          onClick={(e) => {
            e.stopPropagation();
            onApply(stepIndex);
          }}
        >
          <span dangerouslySetInnerHTML={{ __html: isApplying ? SPINNER_ICON : BOLT_ICON }} />
          {isApplying ? "Applying..." : "Apply"}
        </button>
      </div>
      {stepStatus?.status === "error" && stepStatus.text && (
        <div class="step-error-message">{stepStatus.text}</div>
      )}
      <div
        class="step-detail-content message"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(prepareForRender(step.description)),
        }}
      />
    </div>
  );
}
