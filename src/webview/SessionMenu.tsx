import { useState, useRef, useEffect } from "preact/hooks";
import type { SessionInfo } from "./types";

const HISTORY_ICON = `<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-3.2-5l-.8 1.4A4 4 0 1 0 12 8h-2l2.5-3L15 8h-1.5z"/><path d="M8 5v3.2l2.2 1.3-.5.9L7 9V5h1z"/></svg>`;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionMenu({
  sessions,
  activeSessionId,
  disabled,
  onSwitch,
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  disabled: boolean;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function handleSelect(id: string) {
    setOpen(false);
    onSwitch(id);
  }

  return (
    <div class="session-menu-anchor" ref={menuRef}>
      <button
        class="reset-btn"
        data-tooltip="Sessions"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        dangerouslySetInnerHTML={{ __html: HISTORY_ICON }}
      />
      {open && (
        <div class="session-menu">
          {sessions.map((s) => (
            <button
              key={s.id}
              class={`session-menu-item${s.id === activeSessionId ? " session-menu-item-active" : ""}`}
              onClick={() => handleSelect(s.id)}
            >
              <span class="session-menu-time">{relativeTime(s.createdAt)}</span>
              {s.name.length > 35 ? s.name.slice(0, 32) + "..." : s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
