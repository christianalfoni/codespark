import { marked, type RendererObject } from "marked";
import hljs from "highlight.js";

const CLIPBOARD_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2-1.5v2h4v-2a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5zM4 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H4z"/></svg>`;
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>`;
const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z"/></svg>`;
const APPLY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.78 5.24a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L4.22 8.3a.75.75 0 0 1 1.06-1.06L7 8.94l3.72-3.7a.75.75 0 0 1 1.06 0z"/><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8z"/></svg>`;
const FILE_LABEL_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.57 1.14l3.28 3.3.15.36v9.7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 14.5v-13A1.5 1.5 0 013.5 0h6.72l.35.14zM10 1.5v3a.5.5 0 00.5.5h3L10 1.5zM3.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V6h-3.5A1.5 1.5 0 018 4.5V1H3.5z"/></svg>`;

const RUNNABLE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "terminal",
  "console",
]);

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
    // Parse file:path from info string (e.g. "ts file:src/foo.ts")
    let filePath: string | null = null;
    let highlightLang = lang;
    if (lang) {
      const fileMatch = lang.match(/^(\S+)\s+file:(.+)$/);
      if (fileMatch) {
        highlightLang = fileMatch[1];
        filePath = fileMatch[2].trim();
      }
    }

    const highlighted = highlight(text, highlightLang);
    const isRunnable = highlightLang ? RUNNABLE_LANGS.has(highlightLang.toLowerCase()) : false;

    const copyBtn = `<button class="code-action-btn code-copy-btn" title="Copy" data-code="${escapeAttr(text)}">${CLIPBOARD_ICON}</button>`;

    const runBtn = isRunnable
      ? `<button class="code-action-btn code-run-btn" title="Run in terminal" data-command="${escapeAttr(text)}">${PLAY_ICON}</button>`
      : "";

    const applyBtn = filePath
      ? `<button class="code-action-btn code-apply-btn" title="Apply to ${escapeAttr(filePath)}" data-file="${escapeAttr(filePath)}" data-code="${escapeAttr(text)}">${APPLY_ICON}</button>`
      : "";

    const fileLabel = filePath
      ? `<span class="code-file-label" data-file="${escapeAttr(filePath)}">${FILE_LABEL_ICON}${escapeHtml(filePath)}</span>`
      : "";

    const preClass = filePath ? ' class="has-file-label"' : "";

    return `<pre${preClass}>${fileLabel}<div class="code-actions">${applyBtn}${runBtn}${copyBtn}</div><code class="hljs code-content">${highlighted}</code></pre>`;
  },

  html({ text }: { text: string }) {
    // Don't render raw HTML — escape it so it displays as text
    return escapeHtml(text);
  },

  codespan({ text }: { text: string }) {
    return `<code>${escapeHtml(text)}</code>`;
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

