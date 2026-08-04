// Minimal desktop shell for lingo.
// It does NOT embed the server code — it simply spawns the existing
// `npm run start` (the same Node/Express backend) as a child process and opens
// a Chromium window pointed at it. This keeps lingo's source untouched and
// means the native modules (better-sqlite3, onnxruntime) run under the normal
// Node runtime, so no electron-rebuild is required for local testing.

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.LINGO_PORT || 8787;
const APP_URL = `http://localhost:${PORT}/`;

let serverProcess = null;

// Allow only a single instance of the app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/health`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer() {
  // Inherit the current environment (FFMPEG_BIN / LINGO_MODELS_DIR / proxy vars
  // are forwarded automatically when set by a packaged launcher).
  serverProcess = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });
  serverProcess.on("error", (e) => console.error("[lingo] server spawn error:", e));
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await serverUp()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: "lingo",
    backgroundColor: "#0b0f17",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(APP_URL);
  // Open external links (e.g. docs) in the user's real browser, not the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  // If a server is already running on the port (e.g. started manually), just
  // open the window instead of spawning a second one.
  if (!(await serverUp())) {
    startServer();
    await waitForServer();
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* ignore */ }
  }
  if (process.platform !== "darwin") app.quit();
});

// Focus the existing window when a second instance is launched.
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.focus();
});
