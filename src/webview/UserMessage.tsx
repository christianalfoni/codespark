import { useRef, useEffect, useState } from "preact/hooks";
import { renderMarkdown } from "./markdown";
import { prepareForRender } from "./prepareForRender";

const MAX_LINES = 3;
const MAX_CHARS = 200;

function truncateContent(text: string): {
  truncated: string;
  isTruncated: boolean;
} {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) {
    return { truncated: text, isTruncated: false };
  }
  let result = lines.slice(0, MAX_LINES).join("\n");
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS);
  }
  return { truncated: result.trimEnd() + "…", isTruncated: true };
}

export function UserMessage({
  content,
  index,
  registerRef,
}: {
  content: string;
  index: number;
  registerRef: (index: number, el: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { truncated, isTruncated } = truncateContent(content);
  const display = expanded ? content : truncated;
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerRef(index, elRef.current);
    return () => registerRef(index, null);
  }, [index, registerRef]);

  return (
    <div
      ref={elRef}
      class="message message-user"
      onClick={isTruncated ? () => setExpanded((e) => !e) : undefined}
      style={isTruncated ? { cursor: "pointer" } : undefined}
    >
      <div
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(prepareForRender(display)),
        }}
      />
      {isTruncated && (
        <span
          class="message-user__toggle"
          dangerouslySetInnerHTML={{
            __html: expanded
              ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5.5l-4.5 4 .7.8L8 6.9l3.8 3.4.7-.8z"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5l4.5-4-.7-.8L8 9.1 4.2 5.7l-.7.8z"/></svg>',
          }}
        />
      )}
    </div>
  );
}
