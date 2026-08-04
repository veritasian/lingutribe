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
      "/api": "http://localhost:8787",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
