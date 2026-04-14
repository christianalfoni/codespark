# Webview Code Organization

This is a Preact-based UI running inside a VS Code webview panel. It uses Preact with JSX (`preact/hooks`, `preact/compat` is NOT used).

## Component Structure

UI components must be **function exports**, not variable declarations. Each component should be in its own file with a named export.

**Good:**

```typescript
// Logo.tsx
export function Logo() {
  return <div class="container">...</div>;
}
```

**Bad:**

```typescript
// Logo.tsx
const Logo = () => <div class="logo">...</div>;
export default Logo;
```

Use the component in other files via named imports:

```typescript
import { Logo } from "./Logo";
```

Small private helper components may be collocated in the same file as their parent (e.g. `UserMessage` in `App.tsx`), but should not be exported.

## Hook Files

Business logic and state management must be separated into dedicated hook files, not mixed into components.

- Each custom hook gets its own file (e.g., `useAppState.ts`, `useMessageHandling.ts`)
- Hook files export a single custom hook as a named export
- Hooks handle state management, side effects, and event handling logic
- Components remain focused on rendering and delegating to hooks

**Example:**

- Component (`App.tsx`) orchestrates UI and calls hooks
- Hooks (`useAppState.ts`, `useMessageHandling.ts`) handle logic

## File Organization

- `*.tsx` files: UI components (one component per file, small private helpers allowed)
- `use*.ts` files: Custom hooks
- `*.ts` utility files: Pure functions, types, constants (no hooks)
- `*.test.ts` files: Tests (colocated with the file they test)

## Naming Conventions

- Components: PascalCase (`App.tsx`, `Logo.tsx`, `UserMessage`)
- Hooks: camelCase with `use` prefix (`useAppState.ts`, `useMessageHandling.ts`)
- Utilities: lowercase or camelCase (`markdown.ts`, `utils.ts`, `state.ts`, `types.ts`)

## Message Protocol

The webview communicates with the extension via a typed message protocol defined in `types.ts`:

- `WebviewToExtension`: messages sent from webview → extension (e.g. `send`, `cancel`, `new-session`)
- `ExtensionToWebview`: messages sent from extension → webview (e.g. `token`, `tool-start`, `done`)

When adding new message types, define the interface in `types.ts` and add it to the appropriate union type.

## SVG Icons

Inline SVG icons are stored as string constants (template literals). Keep them in the file where they're used, or in `utils.ts` if shared across components.

## HTML Rendering

Use `dangerouslySetInnerHTML` for rendered markdown content and SVG icons. All user-generated markdown goes through `renderMarkdown(prepareForRender(text))` — never skip `prepareForRender` as it repairs streaming artifacts.

## DOM Attributes

Use `class` not `className` — this is Preact without compat mode.
