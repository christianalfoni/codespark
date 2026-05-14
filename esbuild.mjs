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
};

if (watch) {
  const ctx = await esbuild.context(extensionOpts);
  await ctx.watch();
  process.stdout.write("Watching extension...\n");
} else {
  await esbuild.build(extensionOpts);
}
