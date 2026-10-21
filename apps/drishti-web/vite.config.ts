import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: "../..", // root .env
  clearScreen: false, // keep Tauri/turbo logs visible
  server: {
    port: 5173,
    strictPort: true, // Tauri devUrl expects exactly this port
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: "ws://127.0.0.1:3002", ws: true },
      "/stream": { target: "http://127.0.0.1:3002", rewrite: (p) => p.replace(/^\/stream/, "") },
    },
  },
});
