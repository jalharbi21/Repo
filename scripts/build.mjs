// Production build: bundles and minifies the server and the page into dist/.
// Run with `npm run build`, then `npm run start:prod`.
import { build } from "esbuild";
import { mkdir, rm, readFile, writeFile, copyFile } from "node:fs/promises";

const out = "dist";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/public`, { recursive: true });

// Page script: app + providers + navigation engine + sample trip in one minified file.
await build({
  entryPoints: ["public/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  outfile: `${out}/public/app.js`,
  legalComments: "none",
});

// Server: one file with no runtime dependencies. It serves dist/public.
await build({
  entryPoints: ["server.js"],
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: ["node18"],
  outfile: `${out}/server.js`,
});

// Page markup: strip comments and blank lines from the HTML and its inline CSS.
const html = (await readFile("public/index.html", "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s+/gm, "")
  .replace(/\n{2,}/g, "\n");
await writeFile(`${out}/public/index.html`, html);
await copyFile("public/demo-basemap.json", `${out}/public/demo-basemap.json`);
await writeFile(`${out}/package.json`, JSON.stringify({ type: "module", private: true }, null, 2) + "\n");

console.log("Built dist/: run `node dist/server.js` (reads .env from dist/ or the environment).");
