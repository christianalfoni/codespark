# Type Extraction for CLAUDE.md File References

## Problem

CLAUDE.md files can reference source files via links like `[ui-components](../ui/*.ts)`. Currently we inline the full file content. This works but is token-expensive — a 60-line component file might only have 5 lines of useful type surface (props interface + function signature).

If referenced files grow large or numerous, we'll blow past the prompt caching sweet spot and add latency. Extracting just the type surface would keep context compact while still giving the LLM everything it needs to use those APIs correctly.

## When to Pursue This

Not yet. Start with full file content and measure:
- Are referenced files actually large enough to matter?
- Does the LLM perform well with full content?
- Are we hitting token budget issues?

If yes to any, this plan becomes relevant.

## Approach: `ts.createLanguageService()` (Recommended)

TypeScript's language service can emit `.d.ts` declarations — stripping all implementation and keeping only the public type surface. Unlike simpler approaches, it handles inferred types correctly.

### How It Works

A language service is created once at extension activation and kept alive. On each invocation, we call `getEmitOutput(filePath, true)` per referenced `.ts`/`.tsx` file to get declaration-only output.

```ts
import * as ts from "typescript";

// Created once at activation
const service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());

// Per file, at invocation time
const output = service.getEmitOutput(filePath, true /* emitOnlyDtsFiles */);
const dtsText = output.outputFiles[0]?.text;
```

### What It Produces

Input (`ui/Button.tsx`, 60 lines):
```tsx
interface ButtonProps {
  variant?: 'primary' | 'secondary'
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
  children: ReactNode
}

export function Button({ variant = 'primary', ...props }: ButtonProps) {
  const classes = computeClasses(variant, props.size);
  // ... 40 lines of implementation
  return <button className={classes}>{props.children}</button>
}
```

Output (~5 lines):
```ts
interface ButtonProps {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  children: ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
```

### Performance

- Cold start (creating the service): ~160ms (one time at activation)
- First emit per file: ~9ms
- Cached/warm emit: ~0.4ms
- 10 files after warmup: well under 100ms

### Trade-offs

Pros:
- Handles inferred types (no return type annotation needed)
- Produces correct output for React components, hooks, re-exports
- Identical to `tsc --declaration` output
- Incremental — warm calls are sub-millisecond

Cons:
- Requires bundling or depending on `typescript` as a runtime dependency
- Language service needs a `serviceHost` configured with the project's tsconfig
- Only works for TypeScript/TSX files

## Alternative: `oxc-transform` (Fast Path)

The `oxc-transform` package (Rust-based) can generate isolated declarations at ~0.02ms/file. However, it requires explicit type annotations on all exports — inferred types become `unknown`.

Could be used as a fast path: try oxc first, fall back to the language service if there are errors.

```ts
import { isolatedDeclarationSync } from 'oxc-transform';
const result = isolatedDeclarationSync('Button.tsx', sourceText);
// result.code = .d.ts output
// result.errors = missing annotation diagnostics
```

## Alternative: AST-Only Stripping

Use `ts.createSourceFile()` (parsing only, no type checking) to walk the AST and keep exported signatures while stripping function bodies. ~1ms/file.

Loses all inferred types. Only viable if the codebase consistently uses explicit type annotations on exports.

## Integration Point

In `instructions.ts`, the `resolveFileReferences()` function currently inlines full file content. The change would be:

```
.ts / .tsx file → run through declaration emit → inline the .d.ts output
Other files     → inline full content (no change)
```

A new syntax could let users opt in per reference:

```markdown
[ui-components:types](../ui/*.ts)    <!-- extract types only -->
[ui-components](../ui/*.ts)          <!-- full content (default) -->
```

Or it could be automatic for all `.ts`/`.tsx` references, with a flag to override.

## Not Explored

- **VS Code's built-in TypeScript language server** — no API exists for declaration emit through the extension host.
- **`ts.transpileModule()`** — cannot produce declarations.
- **`ts-morph`** — wraps the TS compiler API but adds 1.5MB with no speed benefit.
