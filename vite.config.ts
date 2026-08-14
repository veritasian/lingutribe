import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// In dev, the React app runs on Vite's port and talks to the Express API.
// In production, Express serves the built SPA from dist/ — single process.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "src/web"),
  publicDir: path.resolve(__dirname, "public"),
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@web": path.resolve(__dirname, "src/web"),
    },
  },
  server: {
    // Bind all interfaces (IPv4 + IPv6). Default "localhost" can end up
    // listening on ::1 only, which makes http://localhost:5173 and
    // http://127.0.0.1:5173 unreachable from browsers that resolve to IPv4.
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Proxy real API routes (/api/...) to the Express backend.
      // Use a regex (not the "/api" prefix) so the frontend module
      // src/web/api.ts — which Vite serves at /api.ts — is NOT captured by
      // the proxy. That prefix collision hijacked the module and blanked
      // the dev page.
      // Proxy /api/* to the Express backend. The bypass lets Vite serve the
      // frontend module src/web/api.ts (requested as /api.ts) locally instead
      // of proxying it — otherwise the "/api" prefix hijacked that module and
      // blanked the dev page.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        bypass: (req) => {
          // Vite appends a ?t=<timestamp> cache-buster to module URLs in dev
          // (e.g. /api.ts?t=123). Strip the query before testing so those
          // still resolve to the local frontend module and are NOT proxied to
          // Express — otherwise the backend returns text/html and the browser
          // rejects the module script (MIME mismatch → blank page).
          const url = (req.url || "").split("?")[0];
          if (url.endsWith(".ts")) return req.url;
        },
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
