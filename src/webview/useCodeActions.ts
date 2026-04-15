import * as preact from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Positions `.code-actions` buttons at the visible top-right corner of
 * a hovered `<pre>` block. Repositions on scroll so the button tracks
 * the visible area as long as the cursor is over the code block.
 */
export function useCodeActions(
  messageListRef: preact.RefObject<HTMLDivElement>,
  pinnedQueryRef: preact.RefObject<HTMLDivElement>,
  isStreaming: boolean,
) {
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;

    let activePre: HTMLElement | null = null;
    let activeActions: HTMLElement | null = null;
    let lastMouseX = 0;
    let lastMouseY = 0;

    function position() {
      if (!activePre || !activeActions || !list) return;

      const preRect = activePre.getBoundingClientRect();

      // Account for the pinned query overlay covering the top of the list
      let visibleAreaTop = list.getBoundingClientRect().top;
      const pinned = pinnedQueryRef.current;
      if (pinned && pinned.style.display !== "none") {
        visibleAreaTop = Math.max(visibleAreaTop, pinned.getBoundingClientRect().bottom);
      }

      // How far the pre's top has scrolled above the visible area
      const visibleTop = Math.max(0, visibleAreaTop - preRect.top);
      // Clamp so the button doesn't go past the pre's bottom edge
      const maxTop = activePre.offsetHeight - activeActions.offsetHeight - 6;
      activeActions.style.top = `${Math.min(visibleTop + 6, maxTop)}px`;
    }

    function show(pre: HTMLElement) {
      if (isStreamingRef.current) {
        hide();
        return;
      }

      if (activePre === pre) {
        position();
        return;
      }

      hide();

      const actions = pre.querySelector<HTMLElement>(".code-actions");
      if (!actions) return;

      activePre = pre;
      activeActions = actions;
      actions.classList.add("code-actions-visible");
      position();
    }

    function hide() {
      if (activeActions) {
        activeActions.classList.remove("code-actions-visible");
        activeActions.style.top = "";
      }
      activePre = null;
      activeActions = null;
    }

    function checkUnderCursor() {
      const el = document.elementFromPoint(lastMouseX, lastMouseY) as HTMLElement | null;
      if (!el) { hide(); return; }

      const pre = el.closest("pre");
      if (pre && list!.contains(pre)) {
        show(pre as HTMLElement);
      } else if (activePre) {
        hide();
      }
    }

    function onMouseMove(e: MouseEvent) {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      checkUnderCursor();
    }

    function onScroll() {
      checkUnderCursor();
    }

    function onMouseLeave() {
      hide();
    }

    list.addEventListener("mousemove", onMouseMove);
    list.addEventListener("mouseleave", onMouseLeave);
    list.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      list.removeEventListener("mousemove", onMouseMove);
      list.removeEventListener("mouseleave", onMouseLeave);
      list.removeEventListener("scroll", onScroll);
    };
  }, []);

  // When streaming starts, hide any currently visible code-action buttons so
  // they don't linger on screen until the next pointer event.
  useEffect(() => {
    if (!isStreaming) return;
    const list = messageListRef.current;
    if (!list) return;
    list.querySelectorAll<HTMLElement>(".code-actions-visible").forEach((el) => {
      el.classList.remove("code-actions-visible");
      el.style.top = "";
    });
  }, [isStreaming]);
}
