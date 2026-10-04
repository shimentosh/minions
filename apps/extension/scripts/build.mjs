// Bundles the extension into dist/, ready for chrome://extensions → Load unpacked.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const apiUrl = process.env.MINIONS_API_URL ?? "http://localhost:4600";
const webUrl = process.env.MINIONS_WEB_URL ?? "http://localhost:5180";

mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

// The API origin is the only host the extension may talk to besides the pages it fills.
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
manifest.host_permissions = [`${new URL(apiUrl).origin}/*`];
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
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
