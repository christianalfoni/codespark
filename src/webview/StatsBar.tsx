import { useRef } from "preact/hooks";
import { CHECK_ICON, CLIPBOARD_ICON } from "./markdown";
import { copyCodeWithFeedback } from "./utils";
import type { TokenUsage } from "./state";

interface StatsBarProps {
  numTurns: number;
  conversationText: string;
  usage: TokenUsage;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function StatsBar({
  numTurns,
  conversationText,
  usage,
}: StatsBarProps) {
  const btnRef = useRef<HTMLButtonElement>(null);

  function onCopy() {
    if (btnRef.current) {
      copyCodeWithFeedback(
        conversationText,
        btnRef.current,
        CHECK_ICON,
        CLIPBOARD_ICON,
      );
    }
  }

  const turnsLabel = `${numTurns} ${numTurns === 1 ? "turn" : "turns"}`;
  const hasUsage = usage.totalInputTokens > 0 || usage.totalOutputTokens > 0;

  return (
    <div class="stats-bar">
      <div class="stats-bar-left">
        <span>{turnsLabel}</span>
        {hasUsage && (
          <span
            class="stats-bar-tokens"
            title={`Input: ${usage.totalInputTokens.toLocaleString()} (cache read: ${usage.totalCacheReadTokens.toLocaleString()}, cache create: ${usage.totalCacheCreationTokens.toLocaleString()})\nOutput: ${usage.totalOutputTokens.toLocaleString()}`}
          >
            {formatTokens(usage.totalInputTokens)} in · {formatTokens(usage.totalOutputTokens)} out
          </span>
        )}
      </div>
      <button
        ref={btnRef}
        class="stats-bar-copy"
        title="Copy conversation"
        onClick={onCopy}
        dangerouslySetInnerHTML={{ __html: CLIPBOARD_ICON }}
      />
    </div>
  );
}
