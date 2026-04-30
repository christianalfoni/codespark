import { useRef } from "preact/hooks";
import { CHECK_ICON, CLIPBOARD_ICON } from "./markdown";
import { copyCodeWithFeedback, formatTokens } from "./utils";
import type { TokenUsage } from "./state";

function totalIn(u: TokenUsage): number {
  return u.totalInputTokens + u.totalCacheReadTokens + u.totalCacheCreationTokens;
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

  // assistantContext = true context window after the last turn:
  //   totalIn  = last message_start total (input fed to the final API call)
  //   lastOutputTokens = tokens generated in that call (not yet folded into totalIn)
  // On the next turn, lastOutputTokens will be included in the new message_start
  // total, so the context grows correctly without double-counting.
  //
  // The hover breakdown: in = context - totalOutputTokens, out = totalOutputTokens.
  // totalOutputTokens accumulates all turns' output; because each turn's outputs
  // are already baked into the next message_start as input, subtracting them from
  // context gives a rough measure of the pure-input portion of the context window.
  const assistantContext = totalIn(usage) + usage.lastOutputTokens;
  const assistantOut = usage.totalOutputTokens;
  const hasAssistantUsage = assistantContext > 0 || assistantOut > 0;
  const inlineContext = totalIn(inlineUsage) + inlineUsage.lastOutputTokens;
  const inlineOut = inlineUsage.totalOutputTokens;
  const hasInlineUsage = inlineContext > 0 || inlineOut > 0;

  return (
    <div class="stats-bar">
      <div class="stats-bar-left">
        {hasAssistantUsage && (
          <span class="stats-bar-tokens stats-bar-tokens--hoverable">
            {formatTokens(assistantContext)} tokens{usage.hadThinking ? " · extended thinking" : ""}
            <span class="stats-bar-tokens__detail">
              (in: {formatTokens(assistantContext - assistantOut)}, out: {formatTokens(assistantOut)})
            </span>
          </span>
        )}
        {hasAssistantUsage && hasInlineUsage && <span class="stats-bar-tokens">/</span>}
        {hasInlineUsage && (
          <span class="stats-bar-tokens stats-bar-tokens--hoverable">
            {formatTokens(inlineContext)} tokens fast edit
            <span class="stats-bar-tokens__detail">
              (in: {formatTokens(inlineContext - inlineOut)}, out: {formatTokens(inlineOut)})
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
