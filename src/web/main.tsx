import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Sandboxed preview iframes (and storage-blocked contexts such as strict
// private browsing) throw a SecurityError on ANY localStorage access, which
// crashed the whole app into a blank page at first render. Shim window
// localStorage with a safe no-op wrapper so the app boots everywhere; in a
// normal browser tab this is a transparent pass-through.
try {
  const orig = window.localStorage;
  const safe: Storage = {
    get length() {
      try { return orig.length; } catch { return 0; }
    },
    clear: () => { try { orig.clear(); } catch { /* ignore */ } },
    getItem: (k) => { try { return orig.getItem(k); } catch { return null; } },
    key: (i) => { try { return orig.key(i); } catch { return null; } },
    removeItem: (k) => { try { orig.removeItem(k); } catch { /* ignore */ } },
    setItem: (k, v) => { try { orig.setItem(k, v); } catch { /* ignore */ } },
  };
  Object.defineProperty(window, "localStorage", { value: safe, configurable: true });
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
