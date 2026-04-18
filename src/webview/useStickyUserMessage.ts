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
  const MIRRORED_CLASS = "message-user--mirrored";

  useEffect(() => {
    const root = messageListRef.current;
    const pinned = pinnedRef.current;
    if (!root || !pinned) return;

    function onClick() {
      const source = elementsRef.current.get(currentIndexRef.current);
      if (source) {
        source.click();
        // Re-sync overlay after Preact re-renders the source
        requestAnimationFrame(() => {
          if (currentIndexRef.current !== -1) {
            const updated = elementsRef.current.get(currentIndexRef.current);
            if (updated) {
              pinned!.innerHTML = updated.innerHTML;
              syncDimensions();
            }
          }
        });
      }
    }

    pinned.addEventListener("click", onClick);

    function update() {
      let lastIndex = -1;

      for (const [index, el] of elementsRef.current) {
        if (el.offsetTop < root!.scrollTop) {
          if (index > lastIndex) lastIndex = index;
        }
      }

      if (lastIndex === currentIndexRef.current) return;

      // Unhide the previously mirrored message
      const prev = elementsRef.current.get(currentIndexRef.current);
      if (prev) prev.classList.remove(MIRRORED_CLASS);

      currentIndexRef.current = lastIndex;

      if (lastIndex === -1) {
        pinned!.style.display = "none";
      } else {
        const source = elementsRef.current.get(lastIndex)!;
        pinned!.innerHTML = source.innerHTML;
        pinned!.style.display = "";
        syncDimensions();
        source.classList.add(MIRRORED_CLASS);
      }
    }

    function syncDimensions() {
      if (currentIndexRef.current === -1) return;
      const source = elementsRef.current.get(currentIndexRef.current);
      if (!source) return;
      const sourceRect = source.getBoundingClientRect();
      const parentRect = pinned!.offsetParent!.getBoundingClientRect();
      pinned!.style.left = `${sourceRect.left - parentRect.left}px`;
      pinned!.style.width = `${sourceRect.width}px`;
    }

    function onScroll() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    }

    const resizeObserver = new ResizeObserver(() => {
      syncDimensions();
    });
    resizeObserver.observe(root);

    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      pinned.removeEventListener("click", onClick);
      cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
      // Clean up: remove mirrored class from the currently mirrored message
      const current = elementsRef.current.get(currentIndexRef.current);
      if (current) current.classList.remove(MIRRORED_CLASS);
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
