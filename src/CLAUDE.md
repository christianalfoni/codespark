# CodeSpark - Development Guidelines

## Code Style & Structure

### Control Flow

- **Prefer early returns over nested conditionals**: When validating inputs or handling error cases, return early to avoid deep nesting and improve readability.

  ```typescript
  // Good
  if (!isValid) return;
  if (!hasPermission) return;
  // Main logic here

  // Avoid
  if (isValid) {
    if (hasPermission) {
      // Main logic here
    }
  }
  ```

## Naming Conventions

- Use camelCase for variables and functions
- Use PascalCase for classes and components
- Use UPPER_SNAKE_CASE for constants
- Use descriptive names that indicate purpose/type
