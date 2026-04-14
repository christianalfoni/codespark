import { describe, it, expect } from "vitest";
import { prepareForRender } from "./prepareForRender";

describe("prepareForRender", () => {
  describe("fenced code blocks", () => {
    it("closes an unclosed code fence", () => {
      expect(prepareForRender("```js\nconst x = 1")).toBe(
        "```js\nconst x = 1\n```",
      );
    });

    it("leaves already-closed fences alone", () => {
      expect(prepareForRender("```js\nconst x = 1\n```")).toBe(
        "```js\nconst x = 1\n```",
      );
    });

    it("closes the second fence when two blocks and second is open", () => {
      expect(prepareForRender("```\nfoo\n```\n```ts\nbar")).toBe(
        "```\nfoo\n```\n```ts\nbar\n```",
      );
    });

    it("matches tilde fences", () => {
      expect(prepareForRender("~~~\nfoo")).toBe("~~~\nfoo\n~~~");
    });

    it("does not apply inline repairs inside open code blocks", () => {
      expect(prepareForRender("```\nthis is **bold")).toBe(
        "```\nthis is **bold\n```",
      );
    });

    it("closes a 4+ backtick fence with matching count", () => {
      expect(prepareForRender("````\nfoo")).toBe("````\nfoo\n````");
    });

    it("handles just the opener line with no content yet", () => {
      expect(prepareForRender("```js")).toBe("```js\n```");
    });

    it("does not close a tilde fence with backticks", () => {
      expect(prepareForRender("~~~\nfoo\n```")).toBe("~~~\nfoo\n```\n~~~");
    });

    it("applies inline repairs to text after a closed code block", () => {
      expect(prepareForRender("```\ncode\n```\n**bold")).toBe(
        "```\ncode\n```\n**bold**",
      );
    });

    it("upgrades nested fences with language-specified inner blocks", () => {
      expect(
        prepareForRender(
          "```markdown\n# Hello\n```bash\necho hi\n```\n```",
        ),
      ).toBe("````markdown\n# Hello\n```bash\necho hi\n```\n````");
    });

    it("upgrades nested bare inner fences", () => {
      expect(
        prepareForRender(
          "```markdown\n# Hello\n\n```\ncode\n```\n\nMore text\n```",
        ),
      ).toBe(
        "````markdown\n# Hello\n\n```\ncode\n```\n\nMore text\n````",
      );
    });

    it("does not upgrade already-proper nesting (4 outer, 3 inner)", () => {
      expect(
        prepareForRender(
          "````markdown\n```bash\necho hi\n```\n````",
        ),
      ).toBe("````markdown\n```bash\necho hi\n```\n````");
    });

    it("upgrades nested fences with multiple inner blocks", () => {
      expect(
        prepareForRender(
          "```markdown\n```bash\necho hi\n```\n```python\nprint('x')\n```\n```",
        ),
      ).toBe(
        "````markdown\n```bash\necho hi\n```\n```python\nprint('x')\n```\n````",
      );
    });

    it("upgrades deeply nested fences", () => {
      expect(
        prepareForRender(
          "```md\n```html\n```css\n.a{}\n```\n```\n```",
        ),
      ).toBe("`````md\n````html\n```css\n.a{}\n```\n````\n`````");
    });

    it("closes and upgrades nested fences during streaming (lang inner)", () => {
      expect(
        prepareForRender("```markdown\n# Hello\n```bash\necho hi"),
      ).toBe("````markdown\n# Hello\n```bash\necho hi\n```\n````");
    });

    it("closes and upgrades nested bare fences during streaming", () => {
      expect(
        prepareForRender("```markdown\n# Hello\n```\ncode\n```\nMore"),
      ).toBe("````markdown\n# Hello\n```\ncode\n```\nMore\n````");
    });

    it("does not upgrade two separate code blocks", () => {
      expect(
        prepareForRender("```js\ncode\n```\n\n```py\nmore\n```"),
      ).toBe("```js\ncode\n```\n\n```py\nmore\n```");
    });

    it("does not upgrade lang block followed by bare block", () => {
      const input =
        "text\n\n```python\n# current\ncode\n```\n\n```\n# correct\nmore code\n```\n\n---";
      expect(prepareForRender(input)).toBe(input);
    });

    it("does not upgrade lang block followed by bare block without blank line", () => {
      const input =
        "text\n\n```python\n# current\ncode\n```\n```\n# correct\nmore code\n```\n\n---";
      expect(prepareForRender(input)).toBe(input);
    });
  });

  describe("incomplete links", () => {
    it("strips a link with incomplete URL", () => {
      expect(prepareForRender("see [foo](http://")).toBe("see ");
    });

    it("strips a link with incomplete text", () => {
      expect(prepareForRender("see [foo")).toBe("see ");
    });

    it("strips an incomplete image", () => {
      expect(prepareForRender("check ![alt](http")).toBe("check ");
    });

    it("leaves complete links alone", () => {
      expect(prepareForRender("see [foo](http://bar.com)")).toBe(
        "see [foo](http://bar.com)",
      );
    });

    it("strips just a trailing bracket", () => {
      expect(prepareForRender("hello [")).toBe("hello ");
    });

    it("keeps a complete link and strips a trailing incomplete one", () => {
      expect(prepareForRender("[a](b) and [c")).toBe("[a](b) and ");
    });

    it("does not strip a reference-style link", () => {
      expect(prepareForRender("see [text] for details")).toBe(
        "see [text] for details",
      );
    });
  });

  describe("bold and italic", () => {
    it("closes unclosed bold", () => {
      expect(prepareForRender("this is **bold")).toBe("this is **bold**");
    });

    it("closes unclosed italic", () => {
      expect(prepareForRender("this is *ital")).toBe("this is *ital*");
    });

    it("closes nested bold+italic", () => {
      expect(prepareForRender("**bold and *italic")).toBe(
        "**bold and *italic***",
      );
    });

    it("leaves matched pairs alone", () => {
      expect(prepareForRender("**bold** and *italic*")).toBe(
        "**bold** and *italic*",
      );
    });

    it("closes unclosed underscore bold", () => {
      expect(prepareForRender("this is __bold")).toBe("this is __bold__");
    });

    it("closes unclosed underscore italic", () => {
      expect(prepareForRender("this is _ital")).toBe("this is _ital_");
    });

    it("closes triple asterisk (bold+italic)", () => {
      expect(prepareForRender("***bold italic")).toBe(
        "***bold italic***",
      );
    });

    it("ignores markers inside inline code", () => {
      expect(prepareForRender("`**not bold**` and **actual")).toBe(
        "`**not bold**` and **actual**",
      );
    });

    it("closes unmatched when mixed with matched pairs", () => {
      expect(prepareForRender("**done** and **open")).toBe(
        "**done** and **open**",
      );
    });
  });

  describe("inline code", () => {
    it("closes unclosed single backtick", () => {
      expect(prepareForRender("some `code")).toBe("some `code`");
    });

    it("closes unclosed double backtick", () => {
      expect(prepareForRender("some ``code")).toBe("some ``code``");
    });

    it("leaves matched backticks alone", () => {
      expect(prepareForRender("some `code` here")).toBe(
        "some `code` here",
      );
    });

    it("does not close single backtick with double backtick", () => {
      expect(prepareForRender("some `code ``more")).toBe(
        "some `code ``more`",
      );
    });
  });

  describe("strikethrough", () => {
    it("closes unclosed strikethrough", () => {
      expect(prepareForRender("this is ~~deleted")).toBe(
        "this is ~~deleted~~",
      );
    });

    it("leaves matched strikethrough alone", () => {
      expect(prepareForRender("this is ~~deleted~~ text")).toBe(
        "this is ~~deleted~~ text",
      );
    });
  });

  describe("tables", () => {
    it("appends missing trailing pipe", () => {
      expect(prepareForRender("| a | b |\n| --- | --- |\n| x | y")).toBe(
        "| a | b |\n| --- | --- |\n| x | y |",
      );
    });

    it("leaves complete table rows alone", () => {
      expect(
        prepareForRender("| a | b |\n| --- | --- |\n| x | y |"),
      ).toBe("| a | b |\n| --- | --- |\n| x | y |");
    });
  });

  describe("interactions", () => {
    it("strips incomplete link then closes bold", () => {
      expect(prepareForRender("**bold [link")).toBe("**bold **");
    });

    it("strips incomplete link with bold inside it", () => {
      expect(prepareForRender("see [**text](url")).toBe("see ");
    });

    it("handles heading with unclosed bold", () => {
      expect(prepareForRender("# Title **bold")).toBe(
        "# Title **bold**",
      );
    });
  });

  describe("passthrough", () => {
    it("returns complete markdown unchanged", () => {
      const md =
        "# Hello\n\nSome **bold** and [link](url).\n\n```js\ncode\n```";
      expect(prepareForRender(md)).toBe(md);
    });

    it("handles empty string", () => {
      expect(prepareForRender("")).toBe("");
    });
  });
});
