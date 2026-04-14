export const SEND_ICON = `<svg viewBox="0 0 16 16"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>`;
export const STOP_ICON = `<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;
export const NEW_SESSION_ICON = `<svg viewBox="0 0 16 16"><path d="M14 1H4a1 1 0 0 0-1 1v2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2h1a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-2 13H2V5h10v9zm2-3h-1V4H4V2h10v9z"/></svg>`;
export const FILE_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.57 1.14l3.28 3.3.15.36v9.7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 14.5v-13A1.5 1.5 0 013.5 0h6.72l.35.14zM10 1.5v3a.5.5 0 00.5.5h3L10 1.5zM3.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V6h-3.5A1.5 1.5 0 018 4.5V1H3.5z"/></svg>`;

export function copyCodeWithFeedback(
  code: string,
  button: HTMLButtonElement,
  checkIcon: string,
  clipboardIcon: string
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
  postMessage: (msg: unknown) => void
) {
  const command = button.dataset.command ?? "";
  if (command) {
    postMessage({ type: "run-command", command });
  }
}
