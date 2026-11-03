import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadTokens } from "../../packages/shared/src/authNode";
import { TOKEN_HEADER, type Tokens } from "../../packages/shared/src/auth";

// The services want an access token on every request. In browser dev the page never holds it: this proxy adds it to what it forwards, so a page (ours or any other
// open in the browser) cannot read it. A packaged build talks to the services directly and gets its token from Settings (see settings.ts `accessToken`).
const withToken = (tokens: Tokens | null, target: string, extra: Record<string, unknown> = {}) => ({
  target,
  ...extra,
  headers: tokens ? { [TOKEN_HEADER]: tokens.ui } : undefined,
  // a WebSocket upgrade is forwarded through its own hook, which does not read `headers`
  configure: (proxy: { on(event: string, fn: (req: { setHeader(k: string, v: string): void }) => void): void }) => {
    if (tokens) proxy.on("proxyReqWs", (req) => req.setHeader(TOKEN_HEADER, tokens.ui));
  },
});

export default defineConfig(({ mode }) => {
  const tokens = loadTokens({ ...loadEnv(mode, "../..", ""), ...process.env }); // DRISHTI_TOKEN / DRISHTI_AUTH may live in the root .env
  return {
    plugins: [react(), tailwindcss()],
    envDir: "../..", // root .env
    clearScreen: false, // keep Tauri/turbo logs visible
    server: {
      port: 5173,
      strictPort: true, // Tauri devUrl expects exactly this port
      proxy: {
        "/api": withToken(tokens, "http://127.0.0.1:3001", { rewrite: (p: string) => p.replace(/^\/api/, "") }),
        "/ws": withToken(tokens, "ws://127.0.0.1:3002", { ws: true }),
        "/stream": withToken(tokens, "http://127.0.0.1:3002", { rewrite: (p: string) => p.replace(/^\/stream/, "") }),
      },
    },
  };
});
