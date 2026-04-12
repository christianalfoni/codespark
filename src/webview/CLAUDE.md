# Webview Code Organization

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

- `*.tsx` files: UI components (one component per file)
- `use*.ts` files: Custom hooks
- `*.ts` utility files: Pure functions, types, constants (no hooks)

## Naming Conventions

- Components: PascalCase (`App.tsx`, `Logo.tsx`, `UserMessage`)
- Hooks: camelCase with `use` prefix (`useAppState.ts`, `useMessageHandling.ts`)
- Utilities: lowercase or camelCase (`markdown.ts`, `utils.ts`, `state.ts`, `types.ts`)
