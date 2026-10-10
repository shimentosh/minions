// Bundles the extension into dist/, ready for chrome://extensions → Load unpacked.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
// One deployment: MINIONS_WEB_URL=https://vault.example.com is enough, since the
// production web image serves the API at /api. Development defaults to the dev servers.
const webUrl = (process.env.MINIONS_WEB_URL ?? "http://localhost:5180").replace(/\/$/, "");
const apiUrl = (
  process.env.MINIONS_API_URL ??
  (process.env.MINIONS_WEB_URL ? `${webUrl}/api` : "http://localhost:4600")
).replace(/\/$/, "");

mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

// The API, and the web app (to find its tab for "Sign in with Minions app"), are
// the only hosts the extension talks to besides the pages it fills.
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
manifest.host_permissions = [
  ...new Set([`${new URL(apiUrl).origin}/*`, `${new URL(webUrl).origin}/*`]),
];
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));

const ctx = await esbuild.context({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
    offscreen: "src/offscreen.ts",
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  define: { __API_URL__: JSON.stringify(apiUrl), __WEB_URL__: JSON.stringify(webUrl) },
  logLevel: "info",
});
console.log(`Minions extension → web ${webUrl}, API ${apiUrl}`);
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
