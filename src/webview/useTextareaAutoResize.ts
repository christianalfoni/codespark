import { useRef, useEffect, useCallback } from "preact/hooks";
import * as preact from "preact";

export function useTextareaAutoResize(
  textareaRef: preact.RefObject<HTMLTextAreaElement>,
) {
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
  }, []);

  useEffect(() => {
    textareaRef.current?.addEventListener("input", autoResize);
    return () => textareaRef.current?.removeEventListener("input", autoResize);
  }, [autoResize]);

  return autoResize;
}
