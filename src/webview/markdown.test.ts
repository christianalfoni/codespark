import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  describe("HTML escaping", () => {
    it("escapes a bare self-closing input tag", () => {
      expect(renderMarkdown("<input />")).toContain("&lt;input /&gt;");
      expect(renderMarkdown("<input />")).not.toContain("<input");
    });

    it("escapes inline input tag inside a paragraph", () => {
      const out = renderMarkdown("foo <input /> bar");
      expect(out).toContain("&lt;input /&gt;");
      expect(out).not.toMatch(/<input[^c]/);
    });

    it("escapes input with attributes", () => {
      const out = renderMarkdown('<input type="text" placeholder="hi">');
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).toContain("&lt;input");
    });

    it("escapes script tags", () => {
      const out = renderMarkdown("<script>alert(1)</script>");
      expect(out).not.toContain("<script");
      expect(out).toContain("&lt;script&gt;");
    });

    it("escapes nested HTML blocks", () => {
      const out = renderMarkdown("<div><input /></div>");
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).not.toMatch(/<div>/);
      expect(out).toContain("&lt;div&gt;");
      expect(out).toContain("&lt;input /&gt;");
    });

    it("escapes uppercase tag names", () => {
      const out = renderMarkdown("<INPUT />");
      expect(out).not.toContain("<INPUT");
      expect(out).toContain("&lt;INPUT /&gt;");
    });

    it("escapes HTML comments", () => {
      const out = renderMarkdown("<!-- comment -->");
      expect(out).not.toMatch(/<!--/);
      expect(out).toContain("&lt;!-- comment --&gt;");
    });

    it("escapes input inside list items", () => {
      const out = renderMarkdown("- item with <input />\n- another");
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).toContain("&lt;input /&gt;");
    });

    it("escapes input inside table cells", () => {
      const out = renderMarkdown("| col |\n|-----|\n| <input /> |");
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).toContain("&lt;input /&gt;");
    });

    it("escapes event handler attributes", () => {
      const out = renderMarkdown('<img src=x onerror="alert(1)">');
      expect(out).not.toMatch(/<img\s/);
      expect(out).not.toContain('onerror="alert');
    });

    it("escapes iframe tags", () => {
      const out = renderMarkdown('<iframe src="http://evil.com"></iframe>');
      expect(out).not.toMatch(/<iframe/);
      expect(out).toContain("&lt;iframe");
    });

    it("escapes anchor tags with href", () => {
      const out = renderMarkdown('<a href="http://x">link</a>');
      expect(out).not.toMatch(/<a\s+href/);
      expect(out).toContain("&lt;a href");
    });

    it("escapes form tags", () => {
      const out = renderMarkdown("<form><input type='submit'></form>");
      expect(out).not.toMatch(/<form/);
      expect(out).not.toMatch(/<input[^c]/);
    });

    it("escapes style tags", () => {
      const out = renderMarkdown("<style>body{display:none}</style>");
      expect(out).not.toMatch(/<style/);
      expect(out).toContain("&lt;style&gt;");
    });

    it("escapes tags with extra whitespace", () => {
      const out = renderMarkdown("<input   />");
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).toContain("&lt;input");
    });

    it("escapes HTML inside blockquotes", () => {
      const out = renderMarkdown("> quote with <input />");
      expect(out).not.toMatch(/<input[^c]/);
      expect(out).toContain("&lt;input /&gt;");
    });

    it("escapes attribute values containing angle brackets", () => {
      const out = renderMarkdown('<div title="a>b"></div>');
      expect(out).not.toMatch(/<div\s/);
    });

    it("leaves inline code with HTML escaped as code", () => {
      const out = renderMarkdown("`<input />`");
      expect(out).toContain("<code>");
      expect(out).toContain("&lt;input /&gt;");
      expect(out).not.toMatch(/<input[^c]/);
    });

    it("leaves fenced code block contents as highlighted code, not rendered HTML", () => {
      const out = renderMarkdown("```html\n<input />\n```");
      expect(out).toContain("<pre>");
      expect(out).toContain("<code");
      expect(out).not.toMatch(/<input[^c]/);
    });

    it("escapes ampersands that are not part of entities", () => {
      const out = renderMarkdown("a & b");
      expect(out).toContain("a &amp; b");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code with language in a pre/code block", () => {
      const out = renderMarkdown("```js\nconst x = 1;\n```");
      expect(out).toContain("<pre>");
      expect(out).toContain("<code");
      expect(out).toContain("hljs");
    });

    it("adds a copy button to code blocks", () => {
      const out = renderMarkdown("```\nfoo\n```");
      expect(out).toContain("code-copy-btn");
    });

    it("adds a run button to bash code blocks", () => {
      const out = renderMarkdown("```bash\nls -la\n```");
      expect(out).toContain("code-run-btn");
    });

    it("does not add a run button to non-runnable languages", () => {
      const out = renderMarkdown("```js\nconsole.log(1)\n```");
      expect(out).not.toContain("code-run-btn");
    });

    it("escapes HTML inside code block data-code attributes", () => {
      const out = renderMarkdown("```\n<input />\n```");
      expect(out).toContain('data-code="');
      // The attribute should contain escaped angle brackets, not real ones
      const match = out.match(/data-code="([^"]*)"/);
      expect(match).toBeTruthy();
      expect(match![1]).not.toContain("<");
      expect(match![1]).not.toContain(">");
    });
  });

  describe("standard markdown", () => {
    it("renders bold", () => {
      expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    });

    it("renders italic", () => {
      expect(renderMarkdown("*italic*")).toContain("<em>italic</em>");
    });

    it("renders headings", () => {
      expect(renderMarkdown("# title")).toContain("<h1");
    });

    it("renders unordered lists", () => {
      const out = renderMarkdown("- one\n- two");
      expect(out).toContain("<ul>");
      expect(out).toContain("<li>one</li>");
    });

    it("renders links", () => {
      const out = renderMarkdown("[x](https://example.com)");
      expect(out).toContain('href="https://example.com"');
    });

    it("renders paragraphs separated by blank lines", () => {
      const out = renderMarkdown("one\n\ntwo");
      expect(out).toContain("<p>one</p>");
      expect(out).toContain("<p>two</p>");
    });

    it("renders inline code", () => {
      expect(renderMarkdown("`foo`")).toContain("<code>foo</code>");
    });
  });
});
