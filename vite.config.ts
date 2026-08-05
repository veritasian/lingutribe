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
          if (req.url && req.url.endsWith(".ts")) return req.url;
        },
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
