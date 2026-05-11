import type { BreakdownStep } from "./types";

interface BreakdownProps {
  steps: BreakdownStep[];
  onOpen: (index: number) => void;
}

export function Breakdown({ steps, onOpen }: BreakdownProps) {
  if (steps.length === 0) return null;

  return (
    <div class="breakdown-panel">
      <div class="breakdown-list">
        {[...steps].reverse().map((step, ri) => {
          const i = steps.length - 1 - ri;
          return (
            <div key={i} class="step" onClick={() => onOpen(i)}>
              {step.keyword
                ? <span class={`step-keyword step-keyword--${step.keyword.toLowerCase()}`}>{step.keyword[0]}</span>
                : <span class="step-number">{i + 1}</span>}
              <span class="step-title">{step.title}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
