// Desktop shell for lingutribe.
//
// Two modes:
//  - Dev (`electron .`): spawn the existing `npm run start` (tsx/Express) as a
//    child process, exactly like the old behavior.
//  - Packaged (distributed .app/.dmg): the server is pre-compiled to
//    dist-server/index.mjs. We `import()` it directly into the Electron main
//    process so it runs under Electron's Node ABI (native modules already
//    rebuilt by electron-rebuild). No npm/tsx required at runtime.

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

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

function startDevServer() {
  // Inherit the current environment (FFMPEG_BIN / LINGO_MODELS_DIR / proxy vars
  // are forwarded automatically when set by a packaged launcher).
  serverProcess = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });
  serverProcess.on("error", (e) => console.error("[lingutribe] server spawn error:", e));
}

async function startPackagedServer() {
  // In packaged mode, node_modules + dist-server live under resources/app.
  const appDir = path.join(process.resourcesPath, "app");
  const serverEntry = path.join(appDir, "dist-server", "index.mjs");

  // The app bundle is read-only, so redirect model + library storage to a
  // writable location (~/Library/Application Support/Lingutribe on macOS).
  const userData = app.getPath("userData");
  process.env.LINGO_MODELS_DIR = path.join(userData, "models");
  process.env.LINGO_LIBRARY_DIR = path.join(userData, "library");

  // COCA word-band data ships inside the bundle at Resources/app/data; the
  // server probes __dirname-relative layouts otherwise and would miss it.
  process.env.LINGO_DATA_DIR = path.join(process.resourcesPath, "app", "data");

  // Point the server at the bundled ffmpeg (extraResource) when present.
  const bundledFfmpeg = path.join(process.resourcesPath, "ffmpeg", "ffmpeg");
  if (fs.existsSync(bundledFfmpeg)) {
    process.env.FFMPEG_BIN = bundledFfmpeg;
  }

  if (!fs.existsSync(serverEntry)) {
    console.error("[lingutribe] packaged server missing:", serverEntry);
    return;
  }
  // Importing starts listening on PORT (see src/server/index.ts -> app.listen).
  await import(serverEntry);
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
    title: "lingutribe",
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
    if (app.isPackaged) {
      await startPackagedServer();
    } else {
      startDevServer();
    }
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
