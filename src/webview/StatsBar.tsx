import { useRef } from "preact/hooks";
import { CHECK_ICON, CLIPBOARD_ICON } from "./markdown";
import { copyCodeWithFeedback, formatTokens } from "./utils";
import type { TokenUsage } from "./state";

interface StatsBarProps {
  conversationText: string;
  usage: TokenUsage;
}

function totalIn(u: TokenUsage): number {
  return u.totalInputTokens + u.totalCacheReadTokens + u.totalCacheCreationTokens;
}

export function StatsBar({ conversationText, usage }: StatsBarProps) {
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

  // context = last message_start total (input to the final API call)
  //         + lastOutputTokens (tokens generated in that call, not yet folded into the next message_start)
  // out accumulates across all turns; subtracting it from context gives the pure-input portion.
  const context = totalIn(usage) + usage.lastOutputTokens;
  const out = usage.totalOutputTokens;
  const hasUsage = context > 0 || out > 0;

  return (
    <div class="stats-bar">
      <div class="stats-bar-left">
        {hasUsage && (
          <span class="stats-bar-tokens stats-bar-tokens--hoverable">
            {formatTokens(context)} tokens{usage.hadThinking ? " · extended thinking" : ""}
            <span class="stats-bar-tokens__detail">
              (in: {formatTokens(context - out)}, out: {formatTokens(out)})
            </span>
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
