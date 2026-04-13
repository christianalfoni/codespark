import { useRef, useEffect, useCallback } from "preact/hooks";
import { RefObject } from "preact";

/**
 * Tracks which user message has scrolled past the top of the message list
 * and mirrors its content into a pinned overlay element.
 *
 * The overlay is positioned absolutely over the scroll container (via a
 * wrapper), so it never participates in scroll flow — no sticky toggling,
 * no layout shifts, no blink.
 */
export function useStickyUserMessage(
  messageListRef: RefObject<HTMLDivElement>,
  pinnedRef: RefObject<HTMLDivElement>,
) {
  const elementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const rafRef = useRef(0);
  const currentIndexRef = useRef(-1);

  useEffect(() => {
    const root = messageListRef.current;
    const pinned = pinnedRef.current;
    if (!root || !pinned) return;

    function update() {
      let lastIndex = -1;

      for (const [index, el] of elementsRef.current) {
        if (el.offsetTop < root!.scrollTop) {
          if (index > lastIndex) lastIndex = index;
        }
      }

      if (lastIndex === currentIndexRef.current) return;
      currentIndexRef.current = lastIndex;

      if (lastIndex === -1) {
        pinned!.style.display = "none";
      } else {
        const source = elementsRef.current.get(lastIndex)!;
        pinned!.innerHTML = source.innerHTML;
        pinned!.style.display = "";
      }
    }

    function onScroll() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    }

    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [messageListRef, pinnedRef]);

  const registerUserMessage = useCallback(
    (index: number, el: HTMLElement | null) => {
      if (el) {
        elementsRef.current.set(index, el);
      } else {
        elementsRef.current.delete(index);
      }
    },
    [],
  );

  return { registerUserMessage };
}
