import type { BreakdownStep } from "./types";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";

interface BreakdownProps {
  steps: BreakdownStep[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}

export function Breakdown({ steps, selectedIndex, onSelect }: BreakdownProps) {
  if (steps.length === 0) return null;

  return (
    <div class="breakdown-panel">
      <div class="breakdown-header">Breakdown</div>
      <div class="breakdown-list">
        {steps.map((step, i) => (
          <button
            key={i}
            class={`step${selectedIndex === i ? " step-selected" : ""}`}
            onClick={() => onSelect(selectedIndex === i ? null : i)}
          >
            <span class="step-number">{i + 1}</span>
            <span class="step-title">{step.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function StepDetail({ step }: { step: BreakdownStep }) {
  return (
    <div class="step-detail">
      <div class="step-detail-file">
        {step.filePath}{step.lineHint ? `:${step.lineHint}` : ""}
      </div>
      <div
        class="step-detail-content message"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(prepareForRender(step.description)),
        }}
      />
    </div>
  );
}
