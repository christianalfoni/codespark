import { useRef } from "preact/hooks";
import { CHECK_ICON, CLIPBOARD_ICON } from "./markdown";
import { copyCodeWithFeedback } from "./utils";
import type { TokenUsage } from "./state";

interface StatsBarProps {
  conversationText: string;
  usage: TokenUsage;
  inlineUsage: TokenUsage;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function totalIn(u: TokenUsage): number {
  return u.totalInputTokens + u.totalCacheReadTokens + u.totalCacheCreationTokens;
}

function usageTooltip(u: TokenUsage): string {
  const tin = totalIn(u);
  return (
    `Context: ${tin.toLocaleString()}\n` +
    `  uncached:     ${u.totalInputTokens.toLocaleString()}\n` +
    `  cache read:   ${u.totalCacheReadTokens.toLocaleString()}\n` +
    `  cache create: ${u.totalCacheCreationTokens.toLocaleString()}\n` +
    `Output: ${u.totalOutputTokens.toLocaleString()}`
  );
}

export function StatsBar({
  conversationText,
  usage,
  inlineUsage,
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

  const assistantIn = totalIn(usage);
  const hasAssistantUsage = assistantIn > 0 || usage.totalOutputTokens > 0;
  const inlineIn = totalIn(inlineUsage);
  const hasInlineUsage = inlineIn > 0 || inlineUsage.totalOutputTokens > 0;

  return (
    <div class="stats-bar">
      <div class="stats-bar-left">
        {hasAssistantUsage && (
          <span class="stats-bar-tokens" title={usageTooltip(usage)}>
            {formatTokens(assistantIn)} tokens
          </span>
        )}
        {hasAssistantUsage && hasInlineUsage && <span class="stats-bar-tokens">/</span>}
        {hasInlineUsage && (
          <span class="stats-bar-tokens" title={usageTooltip(inlineUsage)}>
            {formatTokens(inlineIn)} tokens fast edit
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
