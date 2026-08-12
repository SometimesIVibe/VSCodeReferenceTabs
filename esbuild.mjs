import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
};

/**
 * Webview-side syntax-highlighting bundle (highlight.js/lib/core + a
 * curated language set). Plain IIFE for the browser platform — no CSP
 * exceptions, no CDN — loaded by PanelViewProvider before media/panel.js.
 * @type {import('esbuild').BuildOptions}
 */
const hljsOptions = {
  entryPoints: ["src/webview/hljs-entry.js"],
  bundle: true,
  outfile: "media/hljs.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  minify: true,
};

if (watch) {
  const [extensionCtx, hljsCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(hljsOptions),
  ]);
  await Promise.all([extensionCtx.watch(), hljsCtx.watch()]);
  console.log("[esbuild] watching for changes...");
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(hljsOptions)]);
  console.log("[esbuild] build complete");
}
