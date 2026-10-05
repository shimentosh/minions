import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Content-Security-Policy for the production build, as a <meta> tag so it
 * travels with the files whatever serves them. No inline or remote scripts;
 * 'wasm-unsafe-eval' only lets the Argon2 WebAssembly compile. The dev server
 * injects inline scripts, so this is build-only. frame-ancestors and HSTS
 * cannot be set from a meta tag: the web server must send them (SECURITY.md).
 */
function contentSecurityPolicy(apiUrl: string | undefined): Plugin {
  // A relative URL ("/api", same origin behind a proxy) is covered by 'self'.
  const api = apiUrl && /^https?:\/\//.test(apiUrl) ? new URL(apiUrl).origin : "";
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${api ? ` ${api}` : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  return {
    name: "minions-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      },
    ],
  };
}

// The same build serves the browser and the Tauri desktop shell.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_");
  return {
    plugins: [tailwindcss(), react(), contentSecurityPolicy(env.VITE_API_URL)],
    resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
    server: { port: 5180, strictPort: true },
    preview: { port: 5180, strictPort: true },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: { target: "es2022", sourcemap: false },
  };
});
