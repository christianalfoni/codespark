import { useRef } from "preact/hooks";
import { CHECK_ICON, CLIPBOARD_ICON } from "./markdown";
import { copyCodeWithFeedback } from "./utils";

interface StatsBarProps {
  numTurns: number;
  conversationText: string;
}

export function StatsBar({
  numTurns,
  conversationText,
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

  return (
    <div class="stats-bar">
      <div class="stats-bar-left">
        <span>{turnsLabel}</span>
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
