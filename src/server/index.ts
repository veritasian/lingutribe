import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  getDb,
  getLibraryPath,
  setLibraryPath,
  resourcesDir,
  typeDir,
  ttsDir,
  genId,
} from "./db.js";
import { findFfmpeg } from "./util-ffmpeg.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWordsRoutes } from "./routes/words.js";
import { registerNotesRoutes } from "./routes/notes.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerEngineRoutes } from "./routes/engines.js";
import { registerDictRoutes } from "./routes/dict.js";
import { registerResourcesRoutes } from "./routes/resources.js";
import { registerImportRoutes } from "./routes/import.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Keep all local models (Kokoro, Whisper) inside this tool's folder ---
// echogarden decides where to cache models via getAppDataDir():
//   - macOS/Linux: falls back to os.homedir() when no APPDATA env exists
//   - Windows:     honors APPDATA/LOCALAPPDATA BEFORE os.homedir, so overriding
//                 os.homedir has no effect there
// We redirect each platform with the mechanism it actually honors, so every
// model lands under <tool>/data/models regardless of OS.
// Models live under <tool>/data/models by default, but can be redirected via
// LINGO_MODELS_DIR (used when packaged so we never write into a read-only bundle).
const TOOL_MODELS_ROOT = process.env.LINGO_MODELS_DIR
  ? path.resolve(process.env.LINGO_MODELS_DIR)
  : path.resolve(__dirname, "..", "..", "data", "models");
fs.mkdirSync(TOOL_MODELS_ROOT, { recursive: true });

// Route Node's built-in fetch (undici) through an HTTP proxy when one is
// configured (HTTP(S)_PROXY). The built-in fetch ignores those env vars, so
// real-site requests (URL import, RSS) time out with "fetch failed" while the
// curl helper works fine. EnvHttpProxyAgent reads the env at call time — with
// no proxy configured (normal machines) it connects directly.
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const realHomedir = os.homedir.bind(os);

// Where echogarden will place its "packages" folder under a given root.
function echoPackagesDir(root: string): string {
  if (process.platform === "win32") {
    // ECHOGARDEN_APPDATA_DIR is honored first; echogarden appends "echogarden".
    return path.join(root, "echogarden", "packages");
  }
  if (process.platform === "darwin") {
    return path.join(root, "Library", "Application Support", "echogarden", "packages");
  }
  return path.join(root, ".config", "echogarden", "packages");
}

// Where echogarden would have placed packages before this redirect (OS default).
function oldEchoPackagesDir(): string {
  const home = realHomedir();
  if (process.platform === "win32") {
    const appdata = process.env.LOCALAPPDATA || process.env.APPDATA || home;
    return path.join(appdata, "echogarden", "packages");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "echogarden", "packages");
  }
  return path.join(home, ".config", "echogarden", "packages");
}

if (process.platform === "win32") {
  // Windows: set echogarden's own env var (APPDATA would otherwise win).
  process.env.ECHOGARDEN_APPDATA_DIR = TOOL_MODELS_ROOT;
} else {
  // macOS / Linux: no APPDATA env, so a homedir override is respected.
  os.homedir = () => TOOL_MODELS_ROOT;
}

// One-time migration: copy models already downloaded to the OS default location.
const OLD_ECHO = oldEchoPackagesDir();
const NEW_ECHO = echoPackagesDir(TOOL_MODELS_ROOT);
if (fs.existsSync(OLD_ECHO) && OLD_ECHO !== NEW_ECHO) {
  fs.mkdirSync(NEW_ECHO, { recursive: true });
  for (const name of fs.readdirSync(OLD_ECHO)) {
    const src = path.join(OLD_ECHO, name);
    const dst = path.join(NEW_ECHO, name);
    if (!fs.existsSync(dst)) {
      try { fs.cpSync(src, dst, { recursive: true }); } catch { /* ignore */ }
    }
  }
}

// --- Locate ffmpeg (platform-aware) so audio/video import works everywhere ---
// Implementation lives in util-ffmpeg.ts; keep this alias for any callers that
// imported it from index.js previously.
const ffmpegPath = findFfmpeg();

const PORT = Number(process.env.PORT) || 8787;
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) =>
      cb(null, typeDir((req as any).body?.type || "read")),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || "";
      cb(null, `${genId()}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const db = getDb();

// ---------------------------------------------------------------------------
// Settings (persisted as JSON in the settings table)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  libraryPath: getLibraryPath(),
  languages: { learning: "en", native: "zh" },
  engines: {
    stt: { engine: "echogarden", model: "tiny" },
    tts: {
      engine: "kokoro",
      voice: "",
      language: "en",
      kokoroVoice: "Heart",
      kokoroModel: "82m-v1.0-quantized",
      fishModel: "s2.1-pro-free",
      maleVoice: "",
      femaleVoice: "",
      saveAudio: false,
    },
    llm: {
      engine: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:0.6b",
    },
  },
  // Editable system prompts. Empty string => use the built-in default.
  // (Only grammar remains; word lookup now uses the offline MDict engine.)
  prompts: {
    grammar: "",
  },
  // Persisted record of confirmed LLM configurations (so they don't disappear).
  llmHistory: [] as { id: number; ts: string; engine: string; baseUrl: string; model: string }[],
};

function readSettings() {
  const row = db.prepare("SELECT value FROM settings WHERE key='app'").get() as
    | { value: string }
    | undefined;
  const base = DEFAULT_SETTINGS;
  if (!row) return { ...base };
  try {
    // Shallow-merge stored settings over defaults so newly added keys
    // (prompts, llmHistory) are present even for older saved configs.
    return { ...base, ...JSON.parse(row.value) };
  } catch {
    return { ...base };
  }
}

function writeSettings(s: any) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES('app', ?) ON CONFLICT(key) DO UPDATE SET value=?"
  ).run(JSON.stringify(s), JSON.stringify(s));
  if (s.libraryPath && s.libraryPath !== getLibraryPath()) {
    setLibraryPath(s.libraryPath);
  }
  return s;
}

// Resolve the effective LLM config. If a default LLM config has been starred
// in Settings, use its engine/baseUrl/model (history entries don't store the
// API key, so fall back to the live config's key). Mirrors the TTS default
// model behavior.
function resolveLlm(s: any) {
  const live = s.engines?.llm || {};
  if (s.defaultLlmId && Array.isArray(s.llmHistory)) {
    const h = s.llmHistory.find((x: any) => x.id === s.defaultLlmId);
    if (h) {
      return {
        engine: h.engine ?? live.engine,
        baseUrl: h.baseUrl ?? live.baseUrl,
        model: h.model ?? live.model,
        // Strict: the default model uses ONLY its own stored key. Never fall
        // back to the shared live form key — that would let one model be
        // called with a different model's credentials.
        apiKey: h.apiKey ?? undefined,
      };
    }
  }
  return live;
}

// Build a normalized TTS config from a saved entry (or a form config) merged
// over the live fallback. The saved list stores a single "model" field; we
// map it onto the engine-specific field synthesizeSpeech expects.
function buildTtsConfig(h: any, live: any) {
  const engine = h.engine ?? live.engine;
  const resolved: any = {
    engine,
    baseUrl: h.baseUrl ?? live.baseUrl,
    apiKey: h.apiKey ?? live.apiKey,
    voice: h.voice ?? live.voice,
    maleVoice: h.maleVoice ?? live.maleVoice,
    femaleVoice: h.femaleVoice ?? live.femaleVoice,
    kokoroModel: h.kokoroModel ?? live.kokoroModel,
    fishModel: h.fishModel ?? live.fishModel,
    model: h.model ?? live.model,
  };
  if (engine === "kokoro") resolved.kokoroModel = h.model ?? h.kokoroModel ?? live.kokoroModel;
  else if (engine === "fish") resolved.fishModel = h.model ?? h.fishModel ?? live.fishModel;
  return resolved;
}

// Resolve the effective TTS config from the saved engine list. The first item
// (or the entry matching defaultTtsId) wins; falls back to the legacy
// engines.tts object when the list is empty. Mirrors resolveLlm().
function resolveTts(s: any) {
  const live = s.engines?.tts || {};
  if (s.defaultTtsId && Array.isArray(s.ttsHistory)) {
    const h = s.ttsHistory.find((x: any) => x.id === s.defaultTtsId);
    if (h) return buildTtsConfig(h, live);
  }
  return buildTtsConfig({}, live);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() {
  return Date.now();
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// COCA frequency bands (lazy-loaded once, served to the web client for
// per-word coloring in transcripts). Data source: Nation & Crabbe
// BNC/COCA 25k headwords, top 10k.
let _cocaCache: any = null;
app.get("/api/coca/bands", (_req, res) => {
  if (_cocaCache) return res.json(_cocaCache);
  try {
    // data/coca-bands.json lives two levels up from src/server.
    const fp = path.resolve(__dirname, "..", "..", "data", "coca-bands.json");
    const raw = fs.readFileSync(fp, "utf-8");
    _cocaCache = JSON.parse(raw);
    res.json(_cocaCache);
  } catch (e: any) {
    res.status(500).json({ error: "COCA bands not built: " + e.message });
  }
});

// ── Route modules (thin HTTP layer) — business logic lives in engines/,
// analysis.ts, db.ts; these only parse/validate and call it. ─────────────
registerSettingsRoutes(app, { readSettings, writeSettings, dirSize });
registerWordsRoutes(app, { db, now });
registerNotesRoutes(app, { db, now });
registerChatRoutes(app, { db, now });
registerEngineRoutes(app, { readSettings, resolveLlm, resolveTts, buildTtsConfig, upload });
registerDictRoutes(app, { readSettings, resolveLlm });
registerResourcesRoutes(app, { db, now, readSettings, upload });
registerImportRoutes(app, { db, now, upload, ffmpegPath });

app.use(
  "/api/audio",
  express.static(ttsDir())
);
// Built SPA lives in <project>/dist. From src/server that's two levels up.
const distDir = path.resolve(__dirname, "..", "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res) => {
    // Unknown API routes must 404 as JSON — never fall through to the SPA shell.
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`[lingutribe] server on http://localhost:${PORT}`);
  console.log(`[lingutribe] library: ${getLibraryPath()}`);
});
