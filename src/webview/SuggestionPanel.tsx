import type { ReviewSuggestion } from "./state";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

interface SuggestionPanelProps {
  suggestions: ReviewSuggestion[];
  vscode: VsCodeApi;
}

export function SuggestionPanel({ suggestions, vscode }: SuggestionPanelProps) {
  function onDiff(id: string) {
    vscode.postMessage({ type: "suggestion-action", action: "diff", id });
  }

  function onApproveAll() {
    vscode.postMessage({ type: "suggestion-action", action: "approve-all" });
  }

  function onDismiss() {
    vscode.postMessage({ type: "suggestion-action", action: "dismiss" });
  }

  return (
    <div class="suggestion-panel">
      <div class="suggestion-list">
        {suggestions.map((s) => (
          <div key={s.id} class="suggestion-item">
            <a
              class="suggestion-file-link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onDiff(s.id);
              }}
            >
              {s.filePath}
              {s.isNewFile && <span class="suggestion-new-badge">new</span>}
            </a>
            <div class="suggestion-description">{s.description}</div>
          </div>
        ))}
      </div>
      <div class="suggestion-actions">
        <button class="suggestion-approve-btn" onClick={onApproveAll}>
          Approve all
        </button>
        <button class="suggestion-dismiss-btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
