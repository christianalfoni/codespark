import * as preact from "preact";
import { useRef, useEffect, useCallback } from "preact/hooks";

export function useMessageListScroll(
  messageListRef: preact.RefObject<HTMLDivElement>,
  stepListRef: preact.RefObject<HTMLDivElement>,
) {
  const userScrolledUp = useRef(false);

  useEffect(() => {
    if (userScrolledUp.current) return;
    const el = messageListRef.current ?? stepListRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (el.isConnected) {
        el.scrollTop = el.scrollHeight;
      }
    });
  });

  const onScroll = useCallback(() => {
    const el = messageListRef.current ?? stepListRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUp.current = !atBottom;
  }, []);

  return { userScrolledUp, onScroll };
}
