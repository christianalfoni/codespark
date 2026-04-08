import { marked, type RendererObject } from "marked";
import hljs from "highlight.js";

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2-1.5v2h4v-2a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5zM4 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H4z"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>`;
const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>`;

// Path pattern: looks like a file path with extension, optionally with :line
const PATH_RE = /^((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.\w+)(?::(\d+))?$/;

const RUNNABLE_LANGS = new Set(["bash", "sh", "shell", "zsh", "terminal", "console"]);

function highlight(code: string, lang: string | null | undefined): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      // fall through
    }
  }
  // Auto-detect for unlabeled blocks
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

const renderer: RendererObject = {
  code({ text, lang }: { text: string; lang?: string | null }) {
    const highlighted = highlight(text, lang);
    const isRunnable = lang ? RUNNABLE_LANGS.has(lang.toLowerCase()) : false;

    const copyBtn = `<button class="code-action-btn code-copy-btn" title="Copy" data-code="${escapeAttr(text)}">${CLIPBOARD_ICON}</button>`;

    const runBtn = isRunnable
      ? `<button class="code-action-btn code-run-btn" title="Run in terminal" data-command="${escapeAttr(text)}">${PLAY_ICON}</button>`
      : "";

    return `<pre><div class="code-actions">${runBtn}${copyBtn}</div><code class="hljs">${highlighted}</code></pre>`;
  },

  codespan({ text }: { text: string }) {
    const decoded = decodeHtmlEntities(text);
    const match = decoded.match(PATH_RE);
    if (match) {
      const filePath = match[1];
      const line = match[2] || "";
      return `<code class="code-path" data-path="${escapeAttr(filePath)}" data-line="${escapeAttr(line)}">${text}</code>`;
    }
    return `<code>${text}</code>`;
  },
};

marked.use({ renderer });

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false }) as string;
}

export { CHECK_ICON, CLIPBOARD_ICON };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}
