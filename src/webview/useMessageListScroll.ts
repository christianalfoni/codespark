import * as preact from "preact";
import { useRef, useEffect, useCallback } from "preact/hooks";

export function useMessageListScroll(
  messageListRef: preact.RefObject<HTMLDivElement>,
) {
  const userScrolledUp = useRef(false);

  useEffect(() => {
    if (messageListRef.current && !userScrolledUp.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  });

  const onScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUp.current = !atBottom;
  }, []);

  return { userScrolledUp, onScroll };
}
