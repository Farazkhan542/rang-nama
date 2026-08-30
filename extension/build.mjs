// Bundle the content script.
//
// MV3 content scripts cannot use ES module imports directly, so the modular
// source has to be flattened into one classic script. esbuild is the whole
// build: no framework, no transpiler, no polyfills. The output stays readable,
// which matters for an extension a reviewer may want to read.

import { build, context } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const options = {
  entryPoints: ["src/content/content.js"],
  bundle: true,
  format: "iife",
  target: "chrome110",
  outfile: "dist/content.js",
  logLevel: "info",
  // Readable rather than minified. The panel runs on someone else's page and
  // an auditor should be able to confirm it makes no network calls.
  minify: false,
  legalComments: "inline",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(options);
}
