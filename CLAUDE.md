# CodeSpark

VS Code extension that integrates Claude Code CLI for inline editing and research.

## Project Structure

- `src/` — Extension source (TypeScript, compiled to `out/`)
- `src/webview/` — Preact-based UI for the research panel
- `src/mcp-server.ts` — Standalone MCP server process (spawned by the extension)
- `media/` — Icons, logos, stylesheets

## Build & Development

```bash
npm run build
```

The extension uses esbuild to bundle both the extension host code and the webview code.

## Versioning

This project uses semver. "Minor version" means semver minor (0.x.0), not patch. Version bumps are tracked in commit messages with the format `v0.X.Y: Description`.

## Commit Message Format

Version bump commits: `v0.X.Y: Short description of changes`
Other commits: `type: description` (e.g. `fix:`, `chore:`, `ci:`)

## Testing

Tests are colocated with source files using `.test.ts` suffix. Run with:

```bash
npm test
```
