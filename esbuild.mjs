import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionOpts = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  // Polyfill import.meta.url so ESM-only deps that use it work in CJS bundle
  banner: {
    js: `var import_meta_url = require("url").pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "import_meta_url",
  },
};

/** @type {import('esbuild').BuildOptions} */
/** @type {import('esbuild').BuildOptions} */
const mcpServerOpts = {
  entryPoints: ["./src/mcp-server/index.ts"],
  bundle: true,
  outfile: "out/mcp-server.js",
  format: "cjs",
  platform: "node",
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewOpts = {
  entryPoints: ["./src/webview/main.tsx"],
  bundle: true,
  outdir: "out",
  entryNames: "webview",
  format: "iife",
  platform: "browser",
  sourcemap: true,
  loader: { ".css": "css" },
  jsx: "automatic",
  jsxImportSource: "preact",
};

if (watch) {
  const [extCtx, mcpCtx, webCtx] = await Promise.all([
    esbuild.context(extensionOpts),
    esbuild.context(mcpServerOpts),
    esbuild.context(webviewOpts),
  ]);
  await Promise.all([extCtx.watch(), mcpCtx.watch(), webCtx.watch()]);
  process.stdout.write("Watching extension + mcp-server + webview...\n");
} else {
  await Promise.all([
    esbuild.build(extensionOpts),
    esbuild.build(mcpServerOpts),
    esbuild.build(webviewOpts),
  ]);
}
