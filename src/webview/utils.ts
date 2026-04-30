export const SEND_ICON = `<svg viewBox="0 0 16 16"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>`;
export const STOP_ICON = `<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;
export const NEW_SESSION_ICON = `<svg viewBox="0 0 16 16"><path d="M14 1H4a1 1 0 0 0-1 1v2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2h1a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-2 13H2V5h10v9zm2-3h-1V4H4V2h10v9z"/></svg>`;
export const FILE_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.57 1.14l3.28 3.3.15.36v9.7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 14.5v-13A1.5 1.5 0 013.5 0h6.72l.35.14zM10 1.5v3a.5.5 0 00.5.5h3L10 1.5zM3.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V6h-3.5A1.5 1.5 0 018 4.5V1H3.5z"/></svg>`;
export const REVIEW_ICON = `<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.5 5.5L7 10 4.5 7.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const BOLT_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14.5 2L5 13h6.5L9.5 22L19 11h-6.5L14.5 2Z"/></svg>`;
export const STACK_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="4" cy="8" r="1.5"/><path d="M7 3.5h6M7 8h6M7 12.5h6"/></svg>`;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function copyCodeWithFeedback(
  code: string,
  button: HTMLButtonElement,
  checkIcon: string,
  clipboardIcon: string,
) {
  navigator.clipboard.writeText(code);
  button.innerHTML = checkIcon;
  button.classList.add("code-copy-btn-copied");
  setTimeout(() => {
    button.innerHTML = clipboardIcon;
    button.classList.remove("code-copy-btn-copied");
  }, 1000);
}

export function handleCommandClick(
  button: HTMLButtonElement,
  postMessage: (msg: unknown) => void,
) {
  const command = button.dataset.command ?? "";
  if (command) {
    postMessage({ type: "run-command", command });
  }
}
