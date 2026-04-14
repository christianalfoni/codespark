import { useRef } from "preact/hooks";
import { useInlinePromptCapture } from "./useInlinePromptCapture";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

interface Props {
  vscode: VsCodeApi;
}

export function InlinePromptCapture({ vscode }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handlers = useInlinePromptCapture(inputRef, vscode);

  return (
    <input
      ref={inputRef}
      type="text"
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: "fixed",
        left: "-9999px",
        top: "-9999px",
        width: "1px",
        height: "1px",
        opacity: 0,
        pointerEvents: "none",
      }}
      onInput={handlers.onInput}
      onKeyDown={handlers.onKeyDown}
      onBlur={handlers.onBlur}
    />
  );
}
