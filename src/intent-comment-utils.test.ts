import { describe, it, expect } from "vitest";
import { isInJsxContext, getCommentStyle } from "./intent-comment-utils";

// Helper: split a template string into lines and return [lines, lineIndex]
// where lineIndex is the line containing the "|" marker (which is then removed).
function parse(template: string): [string[], number] {
  const raw = template.startsWith("\n") ? template.slice(1) : template;
  const lines = raw.split("\n");
  const lineIndex = lines.findIndex((l) => l.includes("|"));
  if (lineIndex === -1) throw new Error("No | marker found in template");
  lines[lineIndex] = lines[lineIndex].replace("|", "");
  return [lines, lineIndex];
}

// ---------------------------------------------------------------------------
// isInJsxContext
// ---------------------------------------------------------------------------

describe("isInJsxContext", () => {
  describe("returns false outside JSX", () => {
    it("plain JS variable declaration", () => {
      const [lines, li] = parse(`
const x = 1;
|const y = 2;
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("stops at return boundary", () => {
      const [lines, li] = parse(`
function foo() {
  return <div />;
  |
}
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("stops at const boundary", () => {
      const [lines, li] = parse(`
const Component = () => (
  <div />
);
|const x = 1;
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("stops at function boundary", () => {
      const [lines, li] = parse(`
function render() {
  return <div />;
}
|
function other() {
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("stops at type boundary", () => {
      const [lines, li] = parse(`
type Props = {
  |name: string;
};
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("stops at interface boundary", () => {
      const [lines, li] = parse(`
interface Config {
  |key: string;
}
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });
  });

  describe("returns true inside JSX", () => {
    it("blank line between JSX open and close tags", () => {
      const [lines, li] = parse(`
return (
  <div>
    |
  </div>
);
`);
      expect(isInJsxContext(lines, li)).toBe(true);
    });

    it("sibling element after another element", () => {
      const [lines, li] = parse(`
return (
  <div>
    <span>text</span>
    |
  </div>
);
`);
      expect(isInJsxContext(lines, li)).toBe(true);
    });

    it("nested JSX children", () => {
      const [lines, li] = parse(`
return (
  <div>
    <ul>
      |
    </ul>
  </div>
);
`);
      expect(isInJsxContext(lines, li)).toBe(true);
    });
  });

  describe("bug: cursor ON a JSX opening tag should NOT be JSX context", () => {
    // When cursor is on <div>, inserting a comment puts it ABOVE <div>,
    // at the same level — that is NOT inside JSX children, so use // not {/* */}.
    it("cursor line is the JSX opening tag itself", () => {
      const [lines, li] = parse(`
return (
  |<div>
  </div>
);
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("cursor line is a self-closing JSX element", () => {
      const [lines, li] = parse(`
return (
  |<Input />
);
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });
  });

  describe("bug: TypeScript generics must not be counted as JSX opens", () => {
    it("Array<string> does not trigger JSX context", () => {
      const [lines, li] = parse(`
const items: Array<string> = [];
|const x = 1;
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("Promise<void> does not trigger JSX context", () => {
      const [lines, li] = parse(`
async function load(): Promise<void> {
  |
}
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("Map<string, number> does not trigger JSX context", () => {
      const [lines, li] = parse(`
const map = new Map<string, number>();
|const x = 1;
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });

    it("object with generic value does not trigger JSX context", () => {
      // This was bug 3: generic inside an object literal caused false positive
      const [lines, li] = parse(`
const obj = {
  items: [] as Array<string>,
  |key: "value",
};
`);
      expect(isInJsxContext(lines, li)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getCommentStyle
// ---------------------------------------------------------------------------

describe("getCommentStyle", () => {
  describe("non-JSX language IDs always use their fixed style", () => {
    it("typescript → //", () => {
      const style = getCommentStyle("typescript", [], 0);
      expect(style).toEqual({ before: "// ", after: "" });
    });

    it("javascript → //", () => {
      const style = getCommentStyle("javascript", [], 0);
      expect(style).toEqual({ before: "// ", after: "" });
    });

    it("python → #", () => {
      expect(getCommentStyle("python", [], 0)).toEqual({ before: "# ", after: "" });
    });

    it("css → /* */", () => {
      expect(getCommentStyle("css", [], 0)).toEqual({ before: "/* ", after: " */" });
    });

    it("html → <!-- -->", () => {
      expect(getCommentStyle("html", [], 0)).toEqual({
        before: "<!-- ",
        after: " -->",
      });
    });

    it("sql → --", () => {
      expect(getCommentStyle("sql", [], 0)).toEqual({ before: "-- ", after: "" });
    });

    it("unknown → //", () => {
      expect(getCommentStyle("cobol", [], 0)).toEqual({ before: "// ", after: "" });
    });
  });

  describe("typescriptreact picks style based on JSX context", () => {
    it("inside JSX → {/* */}", () => {
      const [lines, li] = parse(`
return (
  <div>
    |
  </div>
);
`);
      expect(getCommentStyle("typescriptreact", lines, li)).toEqual({
        before: "{/* ",
        after: " */}",
      });
    });

    it("outside JSX (before top-level element) → //", () => {
      // Cursor is ON the <div> line — insertion goes above it, not inside JSX
      const [lines, li] = parse(`
return (
  |<div>
  </div>
);
`);
      expect(getCommentStyle("typescriptreact", lines, li)).toEqual({
        before: "// ",
        after: "",
      });
    });

    it("plain TS code in TSX file → //", () => {
      const [lines, li] = parse(`
const x = 1;
|const y = 2;
`);
      expect(getCommentStyle("typescriptreact", lines, li)).toEqual({
        before: "// ",
        after: "",
      });
    });
  });

  describe("javascriptreact picks style based on JSX context", () => {
    it("inside JSX → {/* */}", () => {
      const [lines, li] = parse(`
return (
  <div>
    |
  </div>
);
`);
      expect(getCommentStyle("javascriptreact", lines, li)).toEqual({
        before: "{/* ",
        after: " */}",
      });
    });

    it("outside JSX → //", () => {
      const [lines, li] = parse(`
const x = 1;
|
`);
      expect(getCommentStyle("javascriptreact", lines, li)).toEqual({
        before: "// ",
        after: "",
      });
    });
  });
});
