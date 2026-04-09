export const SEND_ICON = `<svg viewBox="0 0 16 16"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>`;
export const STOP_ICON = `<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;
export const NEW_SESSION_ICON = `<svg viewBox="0 0 16 16"><path d="M14 1H4a1 1 0 0 0-1 1v2H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2h1a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm-2 13H2V5h10v9zm2-3h-1V4H4V2h10v9z"/></svg>`;

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

export function handleFilePathClick(
  codePath: HTMLElement,
  postMessage: (msg: unknown) => void
) {
  const path = codePath.dataset.path;
  const line = codePath.dataset.line;
  if (path) {
    postMessage({
      type: "open-file",
      path,
      line: line ? parseInt(line, 10) : undefined,
    });
  }
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
