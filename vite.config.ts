import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  server: {
    proxy: {
      // changeOrigin: false keeps the browser's Host, so the backend's same-origin
      // CSRF check sees Origin and Host agreeing. Vite defaults it to true for
      // string targets, which rewrites Host to the backend and makes every write
      // look cross-site (403, and a proxy reset for large bodies).
      "/api": { target: "http://127.0.0.1:6499", changeOrigin: false },
      "/healthz": { target: "http://127.0.0.1:6499", changeOrigin: false },
    },
  },
});
