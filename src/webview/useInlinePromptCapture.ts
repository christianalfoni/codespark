import { useEffect, useRef } from "preact/hooks";
import type * as preact from "preact";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

export function useInlinePromptCapture(
  inputRef: preact.RefObject<HTMLInputElement>,
  vscode: VsCodeApi,
) {
  const activeRef = useRef(false);

  function postValue(el: HTMLInputElement) {
    vscode.postMessage({
      type: "inline-prompt-value",
      value: el.value,
      caret: el.selectionStart ?? el.value.length,
    });
  }

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "inline-prompt-start") {
        const el = inputRef.current;
        if (!el) return;
        el.value = "";
        activeRef.current = true;
        requestAnimationFrame(() => {
          el.focus();
        });
        return;
      }

      if (msg.type === "inline-prompt-stop") {
        activeRef.current = false;
        inputRef.current?.blur();
      }
    }

    // selectionchange on document fires for <input> caret moves too — the only
    // reliable way to detect arrow-key caret movement without mutating value.
    function onSelectionChange() {
      if (!activeRef.current) return;
      const el = inputRef.current;
      if (!el || document.activeElement !== el) return;
      postValue(el);
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [inputRef, vscode]);

  function onInput(ev: Event) {
    if (!activeRef.current) return;
    postValue(ev.currentTarget as HTMLInputElement);
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (!activeRef.current) return;
    const el = ev.currentTarget as HTMLInputElement;

    if (ev.key === "Enter") {
      ev.preventDefault();
      activeRef.current = false;
      vscode.postMessage({ type: "inline-prompt-submit", value: el.value });
      return;
    }

    if (ev.key === "Escape") {
      ev.preventDefault();
      activeRef.current = false;
      vscode.postMessage({ type: "inline-prompt-cancel" });
      return;
    }
  }

  function onBlur() {
    if (!activeRef.current) return;
    activeRef.current = false;
    vscode.postMessage({ type: "inline-prompt-cancel" });
  }

  return { onInput, onKeyDown, onBlur };
}
