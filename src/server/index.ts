import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  getDb,
  getLibraryPath,
  setLibraryPath,
  resourcesDir,
  typeDir,
  ttsDir,
  resolveResourceFile,
  genId,
} from "./db.js";
import {
  transcribeFile,
  synthesizeSpeech,
  ensureModel,
  ensureKokoro,
  getKokoroVoices,
  sttPackageName,
  chatWithLLM,
  type ChatMessage,
} from "./engines.js";
import { Mdict } from "@divisey/js-mdict";

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
function findFfmpeg(): string | null {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where", ["ffmpeg"], { windowsHide: true })
        .toString().trim();
      return out.split(/\r?\n/)[0] || null;
    } catch {
      return null; // yt-dlp will fall back to ffmpeg on PATH
    }
  }
  for (const c of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
  }
  try {
    const out = execFileSync("which", ["ffmpeg"]).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
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

app.get("/api/settings", (_req, res) => res.json(readSettings()));
app.put("/api/settings", (req, res) => {
  const cur = readSettings();
  const next = { ...cur, ...req.body };
  res.json(writeSettings(next));
});

app.get("/api/disk", (_req, res) => {
  const lib = getLibraryPath();
  const stat = fs.statfsSync(lib);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const usedBytes = totalBytes - freeBytes;
  const resourcesBytes =
    dirSize(typeDir("audio")) + dirSize(typeDir("video")) + dirSize(typeDir("read")) + dirSize(ttsDir());
  res.json({
    libraryPath: lib,
    totalBytes,
    usedBytes,
    freeBytes,
    resourcesBytes,
  });
});

// --- Resources ---
app.get("/api/resources", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM resources ORDER BY createdAt DESC")
    .all();
  res.json(rows);
});

app.post("/api/resources", upload.single("file"), (req, res) => {
  try {
    const f = req.file!;
    const type = (req.body.type || "audio") as string;
    const name = req.body.name || f.originalname;
    // multer's destination callback may run before req.body.type is parsed
    // (field ordering), so move the file into the correct type folder now to
    // keep relativePath and the on-disk location in sync.
    const target = path.join(typeDir(type), f.filename);
    if (path.resolve(f.path) !== path.resolve(target)) {
      fs.mkdirSync(typeDir(type), { recursive: true });
      fs.renameSync(f.path, target);
    }
    const row = {
      id: genId(),
      type,
      name,
      filename: f.originalname,
      relativePath: `${type}/${f.filename}`,
      size: f.size,
      duration: req.body.duration ? Number(req.body.duration) : null,
      mimeType: f.mimetype,
      transcript: "",
      note: "",
      createdAt: now(),
      updatedAt: now(),
    };
    db.prepare(
      `INSERT INTO resources(id,type,name,filename,relativePath,size,duration,mimeType,transcript,note,createdAt,updatedAt)
       VALUES(@id,@type,@name,@filename,@relativePath,@size,@duration,@mimeType,@transcript,@note,@createdAt,@updatedAt)`
    ).run(row);
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/resources/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

app.get("/api/resources/:id/file", (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id=?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const fp = resolveResourceFile(row.relativePath);
  if (!fp) return res.status(404).json({ error: "file missing" });
  res.sendFile(fp);
});

app.delete("/api/resources/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id=?").get(req.params.id) as any;
  if (row) {
    const fp = resolveResourceFile(row.relativePath);
    try {
      fp && fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    db.prepare("DELETE FROM resources WHERE id=?").run(req.params.id);
  }
  res.json({ ok: true });
});

app.put("/api/resources/:id", (req, res) => {
  const b = req.body;
  db.prepare(
    "UPDATE resources SET transcript=?, words=?, note=?, updatedAt=? WHERE id=?"
  ).run(b.transcript ?? "", b.words ?? "", b.note ?? "", now(), req.params.id);
  res.json({ ok: true });
});

app.post("/api/resources/:id/transcribe", async (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id=?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const fp = resolveResourceFile(row.relativePath);
  if (!fp) return res.status(404).json({ error: "file missing" });
  try {
    const settings = readSettings();
    const result = await transcribeFile(
      fp,
      settings.engines.stt.model,
      req.body.language || "en"
    );
    db.prepare("UPDATE resources SET transcript=?, words=?, updatedAt=? WHERE id=?").run(
      result.transcript,
      JSON.stringify(result.words || []),
      now(),
      req.params.id
    );
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- URL import (video link / podcast link) ---
// Pull media + subtitles directly when available (no STT needed). Falls
// back to STT later via the Transcribe button when no subtitle exists.
interface ImpWord { text: string; start: number; end: number }

function parseTimestamp(ts: string): number {
  // "00:01:02.500" or "00:01:02,500" or "01:02.500"
  const m = ts.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/) || ts.trim().match(/(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  if (m[4] !== undefined) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  return +m[1] * 60 + +m[2] + +m[3] / 1000;
}

function parseSubtitlesFile(fp: string): { transcript: string; words: ImpWord[] } | null {
  const raw = fs.readFileSync(fp, "utf8");
  const cues = raw.replace(/\r/g, "").split(/\n\n+/);
  // YouTube auto-captions use a "pop-on" stack where each (start,end) range
  // contains multiple position cues (Psychologist, Psychologist Gabriele,
  // Psychologist Gabriele Oettingen, …).  Group by (start,end) and keep only
  // the longest text per range — the most complete version.
  const byRange = new Map<string, { start: number; end: number; text: string }>();
  for (const cue of cues) {
    const lines = cue.split("\n").filter((l) => l.trim().length);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) continue;
    const tm = lines[ti].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!tm) continue;
    const start = parseTimestamp(tm[1]);
    const end = parseTimestamp(tm[2]);
    // Strip HTML tags AND insert a space so word-level <c> markers don't
    // glue adjacent words together (otherwise "Oettingen<c>has</c>" → "Oettingenhas").
    const rawText = lines.slice(ti + 1).join(" ");
    const text = rawText
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const key = `${start}|${end}`;
    const prev = byRange.get(key);
    if (!prev || text.length > prev.text.length) {
      byRange.set(key, { start, end, text });
    }
  }
  // Sort by start time, build transcript + words.
  const sorted = [...byRange.values()].sort((a, b) => a.start - b.start);
  const words: ImpWord[] = [];
  const parts: string[] = [];
  for (const cue of sorted) {
    parts.push(cue.text);
    const toks = cue.text.split(/\s+/).filter(Boolean);
    const n = toks.length || 1;
    toks.forEach((tk, i) => {
      words.push({
        text: tk,
        start: +(cue.start + ((cue.end - cue.start) * i) / n).toFixed(2),
        end: +(cue.start + ((cue.end - cue.start) * (i + 1)) / n).toFixed(2),
      });
    });
  }
  if (!words.length) return null;
  return { transcript: parts.join(" "), words };
}

function ytDlpBin(): string {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  if (process.platform !== "win32") {
    for (const c of ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"]) {
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
    }
  }
  return "yt-dlp"; // resolve via PATH (yt-dlp.exe on Windows, yt-dlp elsewhere)
}

function ytDlp(args: string[]): Promise<string> {
  const bin = ytDlpBin();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 300000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((err.message || "") + " " + (stderr || "").slice(-600)));
        resolve(stdout);
      }
    );
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function fetchRss(
  url: string
): Promise<{ audioUrl?: string; transcriptUrl?: string; title?: string } | null> {
  let txt: string;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    txt = await r.text();
  } catch {
    return null;
  }
  if (!/<rss|<\?xml|<feed/i.test(txt)) return null;
  const item = txt.match(/<item[\s\S]*?<\/item>/i)?.[0] || txt;
  const enc =
    item.match(/<enclosure[^>]*url="([^"]+)"/i)?.[1] ||
    item.match(/<enclosure[^>]*url='([^']+)'/i)?.[1];
  const tr =
    item.match(/<(?:podcast:)?transcript[^>]*url="([^"]+)"/i)?.[1] ||
    item.match(/<(?:podcast:)?transcript[^>]*url='([^']+)'/i)?.[1];
  const title = item
    .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<!\[CDATA\[|\]\]>/g, "")
    .trim();
  return { audioUrl: enc, transcriptUrl: tr, title };
}

app.post("/api/import", async (req, res) => {
  try {
    const { url, type } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
    const isVideo = type === "video";
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "lingo-import-"));
    let mediaFile: string | null = null;
    let title: string | null = null;
    let subs: { transcript: string; words: ImpWord[] } | null = null;

    const outTpl = path.join(work, "%(id)s.%(ext)s");
    const fmt = isVideo
      ? "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
      : "bestaudio[ext=m4a]/bestaudio";
    try {
      await ytDlp([
        "-f", fmt,
        "--write-subs", "--write-auto-subs", "--sub-langs", "en",
        "--write-info-json",
        ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
        "--no-playlist", "--no-update",
        "-o", outTpl, url,
      ]);
    } catch (e: any) {
      // yt-dlp may not support this URL (e.g. a plain podcast RSS feed).
      if (!isVideo) {
        try {
          const rss = await fetchRss(url);
          if (rss?.audioUrl) {
            const ext = path.extname(new URL(rss.audioUrl).pathname) || ".m4a";
            const af = path.join(work, "audio" + ext);
            await downloadFile(rss.audioUrl, af);
            mediaFile = af;
            title = rss.title || title;
            if (rss.transcriptUrl) {
              const tf = path.join(work, "transcript.vtt");
              try {
                await downloadFile(rss.transcriptUrl, tf);
                subs = parseSubtitlesFile(tf);
              } catch {
                /* transcript parse optional */
              }
            }
          }
        } catch {
          /* RSS fallback optional */
        }
      }
      if (!mediaFile) {
        // rethrow only if nothing was fetched
        const files = fs.readdirSync(work);
        const media = files
          .filter((f) => !/\.(vtt|srt|lrc|json|tmp)$/i.test(f))
          .sort((a, b) => fs.statSync(path.join(work, a)).size - fs.statSync(path.join(work, b)).size)
          .pop();
        if (!media) return res.status(422).json({ error: "Could not fetch media: " + (e?.message || "unsupported URL") });
      }
    }

    // Scan work dir for media + subtitle files.
    const files = fs.readdirSync(work);
    if (!mediaFile) {
      const media = files
        .filter((f) => !/\.(vtt|srt|lrc|json|tmp|info\.json)$/i.test(f))
        .sort((a, b) => fs.statSync(path.join(work, a)).size - fs.statSync(path.join(work, b)).size)
        .pop();
      mediaFile = media ? path.join(work, media) : null;
    }
    const sub = files.find((f) => /\.vtt$/i.test(f)) || files.find((f) => /\.srt$/i.test(f));
    if (sub && !subs) subs = parseSubtitlesFile(path.join(work, sub));

    // Extract title from info.json if not already set.
    if (!title) {
      const infoF = files.find((f) => f.endsWith(".info.json"));
      if (infoF) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(work, infoF), "utf8"));
          title = info.title || title;
        } catch { /* ignore parse errors */ }
      }
    }

    if (!mediaFile || !fs.existsSync(mediaFile)) {
      return res.status(422).json({ error: "Could not fetch media from this URL" });
    }

    const ext = path.extname(mediaFile) || (isVideo ? ".mp4" : ".m4a");
    const id = genId();
    const destName = id + ext;
    fs.copyFileSync(mediaFile, path.join(typeDir(type), destName));

    const wordsJson = subs ? JSON.stringify(subs.words) : "";
    const row: any = {
      id,
      type: isVideo ? "video" : "audio",
      name: title || path.basename(mediaFile),
      filename: path.basename(mediaFile),
      relativePath: `${type}/${destName}`,
      size: fs.statSync(mediaFile).size,
      duration: null,
      mimeType: isVideo ? "video/mp4" : "audio/mp4",
      transcript: subs ? subs.transcript : "",
      words: wordsJson,
      note: "",
      createdAt: now(),
      updatedAt: now(),
    };
    db.prepare(
      `INSERT INTO resources(id,type,name,filename,relativePath,size,duration,mimeType,transcript,words,note,createdAt,updatedAt)
       VALUES(@id,@type,@name,@filename,@relativePath,@size,@duration,@mimeType,@transcript,@words,@note,@createdAt,@updatedAt)`
    ).run(row);
    // Clean up temp dir.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ ...row, words: subs ? subs.words : [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Words ---
app.get("/api/words", (_req, res) => {
  res.json(db.prepare("SELECT * FROM words ORDER BY createdAt DESC").all());
});
app.post("/api/words", (req, res) => {
  const b = req.body;
  const row = {
    id: genId(),
    term: b.term,
    phonetics: b.phonetics || "",
    meaning: b.meaning || "",
    example: b.example || "",
    level: 0,
    reviewedAt: null,
    createdAt: now(),
  };
  db.prepare(
    `INSERT INTO words(id,term,phonetics,meaning,example,level,reviewedAt,createdAt)
     VALUES(@id,@term,@phonetics,@meaning,@example,@level,@reviewedAt,@createdAt)`
  ).run(row);
  res.json(row);
});
app.put("/api/words/:id", (req, res) => {
  const b = req.body;
  db.prepare(
    "UPDATE words SET term=?, phonetics=?, meaning=?, example=?, level=?, reviewedAt=? WHERE id=?"
  ).run(
    b.term,
    b.phonetics ?? "",
    b.meaning ?? "",
    b.example ?? "",
    b.level ?? 0,
    b.reviewedAt ?? null,
    req.params.id
  );
  res.json({ ok: true });
});
app.delete("/api/words/:id", (req, res) => {
  db.prepare("DELETE FROM words WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// --- Notes ---
app.get("/api/notes", (_req, res) => {
  res.json(db.prepare("SELECT * FROM notes ORDER BY updatedAt DESC").all());
});
app.post("/api/notes", (req, res) => {
  const b = req.body;
  const row = {
    id: genId(),
    title: b.title || "Untitled",
    body: b.body || "",
    resourceId: b.resourceId || null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(
    `INSERT INTO notes(id,title,body,resourceId,createdAt,updatedAt)
     VALUES(@id,@title,@body,@resourceId,@createdAt,@updatedAt)`
  ).run(row);
  res.json(row);
});
app.put("/api/notes/:id", (req, res) => {
  const b = req.body;
  db.prepare(
    "UPDATE notes SET title=?, body=?, resourceId=?, updatedAt=? WHERE id=?"
  ).run(b.title, b.body, b.resourceId ?? null, now(), req.params.id);
  res.json({ ok: true });
});
app.delete("/api/notes/:id", (req, res) => {
  db.prepare("DELETE FROM notes WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// --- Engines ---
app.post("/api/stt/transcribe", upload.single("file"), async (req, res) => {
  try {
    const fp = req.file!.path;
    const settings = readSettings();
    const result = await transcribeFile(
      fp,
      settings.engines.stt.model,
      req.body.language || "en"
    );
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  try {
    const settings = readSettings();
    const resolved = resolveTts(settings);
    const tts: any = { ...resolved, ...req.body };
    // The generic settings "voice" field is openai-specific (legacy values
    // like "en" break kokoro/fish). For other engines only an explicitly
    // requested voice may win; otherwise male/female voices are picked inside
    // synthesizeSpeech.
    const baseEngine = resolved.engine;
    if (req.body.voice == null && baseEngine !== "openai") {
      tts.voice = undefined;
    }
    // Real-time by default; persist only when the user enables "save TTS audio".
    tts.save = req.body.save ?? !!settings.engines.tts.saveAudio;
    const out = await synthesizeSpeech(req.body.text || "", tts);
    res.json(out); // { url } when saved, { dataUrl } when real-time
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/llm/chat", async (req, res) => {
  try {
    const settings = readSettings();
    const messages = (req.body.messages || []) as ChatMessage[];
    const reply = await chatWithLLM(messages, resolveLlm(settings));
    res.json({ content: reply });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Ask-AI chat history (persisted per thread, e.g. one thread per article) ---
app.get("/api/chat", (req, res) => {
  const thread = String(req.query.thread || "global");
  const messages = db
    .prepare("SELECT id, role, content, createdAt FROM chat_messages WHERE thread=? ORDER BY createdAt ASC")
    .all(thread);
  res.json({ messages });
});

app.post("/api/chat", (req, res) => {
  const { thread, role, content } = req.body || {};
  if (!thread || !role || !content) {
    return res.status(400).json({ error: "thread, role, content required" });
  }
  const row = { id: genId(), thread, role, content, createdAt: now() };
  db.prepare(
    "INSERT INTO chat_messages(id, thread, role, content, createdAt) VALUES(@id, @thread, @role, @content, @createdAt)"
  ).run(row);
  res.json(row);
});

// ---------------------------------------------------------------------------
// Offline dictionary via MDict (.mdx) — mirrors the original Enjoy app.
// Reads .mdx files dropped into <library>/dictionaries. No LLM / cloud needed
// for word lookup; this fully replaces the old LLM-based /api/words/lookup.
// ---------------------------------------------------------------------------
type LoadedDict = { title: string; reader: any; mdd: any[] };

let dictCache: LoadedDict[] | null = null;
let dictCacheKey = "";

function dictsDir(): string {
  return path.join(getLibraryPath(), "dictionaries");
}

// Re-scan only when the directory's contents/mtime change, so a dictionary
// dropped in after the server started is picked up without a restart.
function dirKey(dir: string): string {
  try {
    const mtime = fs.statSync(dir).mtimeMs;
    const files = fs.readdirSync(dir).sort().join("|");
    return `${mtime}:${files}`;
  } catch {
    return "";
  }
}

function loadDicts(): LoadedDict[] {
  const dir = dictsDir();
  const key = dirKey(dir);
  if (dictCache && key === dictCacheKey) return dictCache;
  dictCache = [];
  dictCacheKey = key;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  if (!fs.existsSync(dir)) return dictCache;
  const files = fs.readdirSync(dir);
  const mdds = files
    .filter((f) => f.toLowerCase().endsWith(".mdd"))
    .map((f) => new Mdict(path.join(dir, f)));
  for (const m of files.filter((f) => f.toLowerCase().endsWith(".mdx"))) {
    try {
      const reader = new Mdict(path.join(dir, m));
      dictCache.push({ title: m.replace(/\.mdx$/i, ""), reader, mdd: mdds });
    } catch (err) {
      console.error("[mdict] failed to load", m, err);
    }
  }
  return dictCache;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHtml(s: string): string {
  return s
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/\s+href="[^"]*"/g, "") // neutralize d:/help: cross-ref links
    .replace(/\s+onclick="[^"]*"/g, "");
}

// --- Structured, restricted dictionary display -------------------------------
// OALD8 groups CORE meanings in <span class="n-g"> (numbered groups, often
// marked with ★), idioms in <span class="id-g">, phrasal verbs in <span class="pv-g">.
// Produce a clean card: at most 2 parts of speech, 2 definitions each (numbered),
// English + Chinese on one line, up to 2 example sentences (◆ on their own line).
// Never emit ★ or duplicates.
const MAX_POS = 2;
const MAX_DEFS = 2;
const MAX_EXAMPLES = 2;

function textOf(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[★☆]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Returns the index just past the matching </span> for the <span> opened at openIdx.
function spanCloseEnd(html: string, openIdx: number): number {
  let i = html.indexOf(">", openIdx) + 1;
  let depth = 0;
  const n = html.length;
  while (i < n) {
    if (html.startsWith("<span", i)) {
      depth++;
      i = html.indexOf(">", i) + 1;
    } else if (html.startsWith("</span>", i)) {
      if (depth === 0) return i + "</span>".length;
      depth--;
      i += "</span>".length;
    } else i++;
  }
  return -1;
}
function firstSpanInner(html: string, cls: string): string | null {
  const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "i");
  const m = re.exec(html);
  if (!m) return null;
  const ote = html.indexOf(">", m.index);
  const c = spanCloseEnd(html, m.index);
  if (c < 0) return null;
  return html.slice(ote + 1, c - "</span>".length);
}
function allSpansInner(html: string, cls: string): string[] {
  const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const c = spanCloseEnd(html, m.index);
    if (c < 0) continue;
    const ote = html.indexOf(">", m.index);
    out.push(html.slice(ote + 1, c - "</span>".length));
  }
  return out;
}
interface DictDef {
  en: string;
  cn: string;
  examples: string[];
}
function parseDefInner(defHtml: string): { en: string; cn: string } | null {
  let label = "";
  const li = firstSpanInner(defHtml, "label-g");
  if (li) label = textOf(li);
  const enInner = firstSpanInner(defHtml, "d") || firstSpanInner(defHtml, "ud");
  if (!enInner) return null;
  const ci = firstSpanInner(enInner, "chn");
  const cn = ci ? textOf(ci) : "";
  let enClean = enInner;
  if (ci !== null) {
    const co = enInner.search(/<span\b[^>]*class="[^"]*\bchn\b[^"]*"/i);
    if (co >= 0) {
      const cc = spanCloseEnd(enInner, co);
      enClean = enInner.slice(0, co) + enInner.slice(cc);
    }
  }
  let en = textOf(enClean);
  if (label) en = label + " " + en;
  return { en, cn };
}
function examplesIn(win: string): string[] {
  const xgs = allSpansInner(win, "x-g");
  const out: string[] = [];
  for (const xi of xgs) {
    const x = firstSpanInner(xi, "x");
    if (x) {
      const ex = textOf(x);
      if (ex) out.push(ex);
    }
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out.slice(0, MAX_EXAMPLES);
}
function detectPos(region: string, full: string): string {
  const p = region.match(/class="pos"[^>]*>([^<]*)<\/span>/i);
  if (p && p[1].trim()) return p[1].trim();
  const vocab = [
    "noun","verb","adjective","adverb","preposition","conjunction",
    "pronoun","determiner","exclamation","abbreviation","numeral","modal",
  ];
  const hay = region + " " + full.slice(0, 1500);
  for (const v of vocab) if (new RegExp("\\b" + v + "\\b", "i").test(hay)) return v;
  return "";
}
// Ranges of idiom/phrasal-verb groups that carry an id/pv headword NOT equal to
// the entry headword. Used as a fallback when an entry has no n-g core groups.
function idiomRanges(html: string, word: string): [number, number][] {
  const ranges: [number, number][] = [];
  const wl = word.toLowerCase();
  for (const cls of ["id-g", "idm-g", "pv-g", "phrase", "phr-g"]) {
    const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const c = spanCloseEnd(html, m.index);
      if (c < 0) continue;
      const ote = html.indexOf(">", m.index);
      const inner = html.slice(ote + 1, c - "</span>".length);
      const hm = inner.match(/<span\b[^>]*class="(id|pv)\s*"[^>]*>([\s\S]*?)<\/span>/i);
      if (hm) {
        const hw = textOf(hm[2]).toLowerCase();
        if (hw !== wl) ranges.push([m.index, c]);
      }
    }
  }
  return ranges;
}
function defsFromSection(secHtml: string, word: string): DictDef[] {
  const ngs = allSpansInner(secHtml, "n-g");
  const blocks: DictDef[] = [];
  if (ngs.length) {
    for (const ng of ngs) {
      const di = firstSpanInner(ng, "def-g");
      if (!di) continue;
      const p = parseDefInner(di);
      if (!p) continue;
      blocks.push({ ...p, examples: examplesIn(ng) });
    }
    return blocks;
  }
  // Fallback: no n-g core groups. Skip idiom/phrasal groups, keep remaining def-g.
  const ir = idiomRanges(secHtml, word);
  const inIdiom = (i: number) => ir.some(([a, b]) => i >= a && i < b);
  const re = /<span\b[^>]*class="[^"]*\bdef-g\b[^"]*"/gi;
  let dm: RegExpExecArray | null;
  while ((dm = re.exec(secHtml))) {
    if (inIdiom(dm.index)) continue;
    const c = spanCloseEnd(secHtml, dm.index);
    if (c < 0) continue;
    const ote = secHtml.indexOf(">", dm.index);
    const inner = secHtml.slice(ote + 1, c - "</span>".length);
    const p = parseDefInner(inner);
    if (!p) continue;
    blocks.push({ ...p, examples: examplesIn(inner) });
  }
  return blocks;
}

// Normalize a dictionary audio reference (e.g. sound://uk/run__gb_1.mp3 or
// snd://run__gb_1.spx) into the candidate keys used inside the companion .mdd.
// js-mdict stores resources with a leading backslash and backslash separators
// (e.g. \uk\run__gb_1.mp3), so we try a few plausible forms.
function audioKeyCandidates(ref: string): string[] {
  const noScheme = ref
    .replace(/^sound:\/\//i, "")
    .replace(/^snd:\/\//i, "")
    .replace(/^entry:\/\//i, "");
  const cands = new Set<string>();
  cands.add(noScheme);
  cands.add(noScheme.replace(/^\//, ""));
  cands.add("\\" + noScheme.replace(/\//g, "\\"));
  cands.add("\\" + noScheme.replace(/^\//, "").replace(/\//g, "\\"));
  return [...cands];
}

// Parse an Oxford-style MDict entry into structured fields for a clean card:
// headword, phonetic (IPA + audio ref), and per-part-of-speech sections.
function parseOxford(html: string, word: string) {
  let head = word;
  const hk = html.match(/<hkey>\s*<h[^>]*>([^<]*)<\/h>/);
  if (hk) head = hk[1].trim() || word;

  // Phonetics come from the headword block (<hkey> … <top-g>). The IPA lives in
  // <phon>, the BrE/NAmE labels in <brelabel>/<namelabel>, and the audio key in
  // <pron e gs href="…">. Oxford has no </pron> close, so we scope to that block.
  const phonetic: { label: string; ipa: string; audioRef: string }[] = [];
  const hkRegion = html.match(/<hkey>([\s\S]*?)<top-g>/);
  const region = hkRegion ? hkRegion[1] : html;

  // --- OALD8: <span class="phon-gb"> / <span class="phon-us"> + <a type="sound" href="sound://uk/.."> ---
  const gbIpa = region.match(/class="phon-gb"[^>]*>(.*?)<\/span>/i);
  const usIpa = region.match(/class="phon-us"[^>]*>(.*?)<\/span>/i);
  const soundHrefs = [
    ...region.matchAll(/type="sound"[^>]*\bhref="([^"]+)"/gi),
  ].map((m) => m[1]);
  // --- OALD9 fallback: <phon> + <brelabel>/<namelabel> + gs href ---
  const ipas9 = [...region.matchAll(/<phon>(.*?)<\/phon>/g)].map((m) => m[1]);
  const labels9 = [
    ...region.matchAll(
      /<brelabel>(.*?)<\/brelabel>|<namelabel>(.*?)<\/namelabel>/g
    ),
  ].map((m) => (m[1] || m[2]).replace(/<[^>]+>/g, "").trim());
  const gsRefs = [...region.matchAll(/\bgs href="([^"]+)"/g)].map((m) => m[1]);

  let brE: string | null = gbIpa ? gbIpa[1].trim() : null;
  let naE: string | null = usIpa ? usIpa[1].trim() : null;
  if (!brE || !naE) {
    labels9.forEach((lab, i) => {
      const ipa = ipas9[i];
      if (lab === "BrE" && !brE) brE = ipa;
      if (lab === "NAmE" && !naE) naE = ipa;
    });
  }
  const ukRef =
    soundHrefs.find((h) => /(^|\/)(uk|gb)/i.test(h)) || gsRefs[0] || "";
  const usRef =
    soundHrefs.find((h) => /(^|\/)(us|na)/i.test(h)) ||
    gsRefs[1] ||
    gsRefs[0] ||
    "";
  if (brE) phonetic.push({ label: "BrE", ipa: brE, audioRef: ukRef });
  if (naE) phonetic.push({ label: "NAmE", ipa: naE, audioRef: usRef });

  const sections: { pos: string; html: string }[] = [];
  // OALD9 (legacy 9th-edition layout): <div id="verb" class="cixing_part"> ...
  const secRe =
    /<div id="([^"]+)" class="cixing_part">([\s\S]*?)(?=<div id="[^"]+" class="cixing_part">|$)/g;
  let sm: RegExpExecArray | null;
  let used9 = false;
  while ((sm = secRe.exec(html))) {
    used9 = true;
    const pos = sm[1];
    let body = sm[2].replace(/<hkey>[\s\S]*?<\/hkey>/, ""); // drop repeated headword+IPA block
    body = cleanHtml(body);
    sections.push({ pos, html: body });
  }
  // OALD8: <span ... bookmark="WORD_pos_X" class="Ref"><a backup-class="pos">verb</a>
  //        labels the section; the content is wrapped in <span id="WORD_pos_X">.
  if (!used9) {
    const posAnchors = [
      ...region.matchAll(
        /<span\b[^>]*\bbookmark="([^"]+)"[^>]*>[\s\S]*?<a\b[^>]*\bbackup-class="pos"[^>]*>([^<]*)<\/a>/gi
      ),
    ].map((m) => ({ id: m[1], label: m[2].trim() }));
    if (posAnchors.length) {
      for (let i = 0; i < posAnchors.length; i++) {
        const { id, label } = posAnchors[i];
        const sIdx = html.indexOf(`id="${id}"`);
        if (sIdx < 0) continue;
        const tagEnd = html.indexOf(">", sIdx);
        const nextMarker = posAnchors[i + 1]
          ? html.indexOf(`id="${posAnchors[i + 1].id}"`, tagEnd)
          : -1;
        const endIdx = nextMarker > 0 ? nextMarker : html.length;
        const body = cleanHtml(html.slice(tagEnd + 1, endIdx));
        sections.push({ pos: label || id, html: body });
      }
    } else {
      // Single-POS entries (cat, beautiful, …) have no section wrappers. Use the
      // whole entry and let detectPos figure out the part of speech.
      sections.push({ pos: detectPos(region, html), html: cleanHtml(html) });
    }
  }

  // Restrict to a clean card: at most 2 parts of speech, 2 definitions each.
  const pos: {
    pos: string;
    defs: { num: number; en: string; cn: string; examples: string[] }[];
  }[] = [];
  const seenDefs = new Set<string>();
  for (const sec of sections.slice(0, MAX_POS)) {
    const blocks = defsFromSection(sec.html, word);
    const defs: { num: number; en: string; cn: string; examples: string[] }[] = [];
    for (const b of blocks) {
      if (defs.length >= MAX_DEFS) break;
      const key = b.en.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seenDefs.has(key)) continue;
      seenDefs.add(key);
      defs.push({ num: defs.length + 1, en: b.en, cn: b.cn, examples: b.examples });
    }
    if (defs.length) pos.push({ pos: sec.pos, defs });
  }
  return { word: head, phonetic, pos };
}

function getMddReaders(): any[] {
  return loadDicts().flatMap((d) => d.mdd || []);
}

// Look up an audio resource in the companion .mdd, trying every candidate key
// form. Returns the raw definition (audio bytes) and the matched key, or null.
function mddLookup(ref: string): { def: any; key: string } | null {
  if (!ref) return null;
  const cands = audioKeyCandidates(ref);
  for (const m of getMddReaders()) {
    for (const c of cands) {
      try {
        const r: any = m.lookup(c);
        if (r && r.definition) {
          const d = r.definition;
          const len = Buffer.isBuffer(d)
            ? d.length
            : typeof d === "string"
            ? d.length
            : 0;
          if (len > 0) return { def: d, key: c };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// True only if the .mdd actually contains non-empty data for this key
// (some .mdd files are key-index stubs without the audio/picture bytes).
function mddHas(ref: string): boolean {
  return mddLookup(ref) != null;
}

// Irregular noun/verb inflections → base form (lemma). Used as a high-confidence
// fallback when an exact headword match fails, so inflected tokens still resolve.
const IRREGULAR: Record<string, string> = {
  // nouns
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", people: "person", oxen: "ox", calves: "calf",
  halves: "half", leaves: "leaf", wolves: "wolf", selves: "self", knives: "knife",
  lives: "life", wives: "wife", elves: "elf", loaves: "loaf", shelves: "shelf",
  thieves: "thief",
  // verbs (past / participle)
  went: "go", gone: "go", wrote: "write", written: "write", came: "come",
  became: "become", took: "take", taken: "take", gave: "give", given: "give",
  fell: "fall", fallen: "fall", grew: "grow", grown: "grow", knew: "know",
  known: "know", threw: "throw", thrown: "throw", drew: "draw", drawn: "draw",
  flew: "fly", flown: "fly", blew: "blow", blown: "blow", spoke: "speak",
  spoken: "speak", broke: "break", broken: "break", bore: "bear", born: "bear",
  wore: "wear", worn: "wear", tore: "tear", torn: "tear", stole: "steal",
  stolen: "steal", drove: "drive", driven: "drive", rode: "ride", ridden: "ride",
  rose: "rise", risen: "rise", chose: "choose", chosen: "choose", shook: "shake",
  shaken: "shake", froze: "freeze", frozen: "freeze", awoke: "awake",
  woke: "wake", woken: "wake", sank: "sink", sunk: "sink", swam: "swim",
  swum: "swim", began: "begin", begun: "begin", drank: "drink", drunk: "drink",
  rang: "ring", rung: "ring", sang: "sing", sung: "sing", sprang: "spring",
  sprung: "spring", stood: "stand", understood: "understand", held: "hold",
  kept: "keep", slept: "sleep", felt: "feel", left: "leave", lost: "lose",
  met: "meet", sent: "send", spent: "spend", built: "build", lit: "light",
  burnt: "burn", learnt: "learn", learned: "learn", meant: "mean", bent: "bend",
  lent: "lend", dealt: "deal", heard: "hear", led: "lead", fed: "feed",
  bled: "bleed", fled: "flee", shed: "shed", read: "read", put: "put",
  cut: "cut", set: "set", hit: "hit", let: "let", shut: "shut", cost: "cost",
  burst: "burst", cast: "cast", split: "split", spread: "spread",
  brought: "bring", bought: "buy", thought: "think", caught: "catch",
  taught: "teach", fought: "fight", sought: "seek", made: "make", did: "do",
  done: "do", saw: "see", seen: "see", dug: "dig", stuck: "stick",
  struck: "strike", strung: "string", swung: "swing", hung: "hang",
  won: "win", ran: "run", mistook: "mistake", undertook: "undertake",
  withdrew: "withdraw", overcame: "overcome", underwent: "undergo",
  withheld: "withhold", upheld: "uphold", sped: "speed", swept: "sweep",
  wept: "weep", crept: "creep", dwelt: "dwell", forbade: "forbid",
  forgot: "forget", forgotten: "forget", forbore: "forbear",
  outdid: "outdo", reset: "reset", retook: "retake",
};

// Generate candidate base forms for an inflected token. Order matters: the
// most confident (irregular, then unambiguous plural rules) come first; generic
// -s/-es stripping is tried last and verified by an actual dictionary lookup.
function lemmaCandidates(w: string): string[] {
  const low = w.toLowerCase();
  const out: string[] = [];
  if (IRREGULAR[low]) out.push(IRREGULAR[low]);
  const rules: [RegExp, string][] = [
    [/ies$/, "y"], // babies → baby
    [/yses$/, "ysis"], // analyses → analysis
    [/ches$/, "ch"], // watches → watch
    [/shes$/, "sh"], // dishes → dish
    [/sses$/, "ss"], // classes → class
    [/xes$/, "x"], // boxes → box
    [/oes$/, "o"], // tomatoes → tomato
    [/s$/, ""], // cats → cat, uses → use (try just -s first)
    [/es$/, ""], // boxes/classes fallback → box/class
    [/ied$/, "y"], // tried → try, copied → copy
    [/ed$/, ""], // planned → plan, washed → wash
    [/d$/, ""], // loved → love, used → use
    [/ing$/, ""], // running → run, stopping → stop
    [/ing$/, "e"], // making → make, loving → love
    [/er$/, ""], // faster → fast
    [/er$/, "e"], // nicer → nice
    [/est$/, ""], // fastest → fast
    [/est$/, "e"], // nicest → nice
  ];
  if (low.length > 3) {
    for (const [re, rep] of rules) {
      if (re.test(low)) {
        const cand = low.replace(re, rep);
        if (cand.length >= 2) out.push(cand);
      }
    }
  }
  return Array.from(new Set(out));
}

// Try the word (and its case variants) against every loaded dictionary.
// Returns a fully-shaped result, or null if no dictionary has it.
function tryVariants(dicts: any[], word: string): any | null {
  const variants = Array.from(
    new Set([
      word,
      word.toLowerCase(),
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    ])
  );
  for (const d of dicts) {
    for (const w of variants) {
      try {
        let def: string | null = d.reader.lookup(w)?.definition ?? null;
        if (def && def.startsWith("@@@LINK=")) {
          def = d.reader.lookup(def.substring(8))?.definition ?? null;
        }
        if (def) {
          const entry = parseOxford(def, word);
          return {
            word,
            found: true,
            html: def,
            text: stripTags(def),
            dictTitle: d.title,
            entry,
            hasMdd: dicts.some((x) => (x.mdd || []).length > 0),
            audioAvailable: entry.phonetic.some(
              (p: any) => p.audioRef && mddHas(p.audioRef)
            ),
          };
        }
      } catch (err) {
        console.error("[mdict] lookup error", w, err);
      }
    }
  }
  return null;
}

function lookupWord(word: string) {
  const dicts = loadDicts();
  // Exact headword match first (as typed / lowercase / Title-case).
  const exact = tryVariants(dicts, word);
  if (exact) return exact;
  // No exact entry — the token is almost certainly an inflected form (plural,
  // verb tense, comparative). Strip the inflectional suffix / map the irregular
  // form and retry on the base (lemma). The first lemma that actually exists
  // in the dictionary wins.
  for (const lemma of lemmaCandidates(word)) {
    const r = tryVariants(dicts, lemma);
    if (r) {
      return { ...r, lemmatized: true, lemma, word };
    }
  }
  return {
    word,
    found: false,
    html: null,
    text: null,
    dictTitle: null,
    hasMdd: dicts.some((x) => (x.mdd || []).length > 0),
    audioAvailable: false,
  };
}

app.get("/api/dict/list", (_req, res) => {
  const dicts = loadDicts();
  res.json({ dictionaries: dicts.map((d) => d.title), dir: dictsDir() });
});

app.get("/api/dict/lookup", (req, res) => {
  const word = String(req.query.word || "").trim();
  if (!word) return res.status(400).json({ error: "word required" });
  const r = lookupWord(word);
  if (!r.found) {
    return res.json({
      ...r,
      message: "No local dictionary entry. Drop a .mdx file into " + dictsDir(),
    });
  }
  res.json(r);
});

// LLM fallback for words with no local MDict entry. Returns a concise,
// dictionary-style explanation (part of speech + 2 definitions + 2 examples).
const DEFAULT_DICT_LLM_PROMPT = `You are a concise bilingual dictionary. For the headword "{WORD}", provide:
- Part of speech (e.g. n. / v. / adj. / adv.)
- Two clear definitions: a short English explanation followed by a concise Chinese translation.
- Two representative example sentences (English) showing natural usage.
Keep the entire answer under 150 words. Plain text, no markdown headings, no bullets beyond the structure above.`;

app.post("/api/dict/llm", async (req, res) => {
  try {
    const settings = readSettings();
    const word = String(req.body.word || "").trim();
    if (!word) return res.status(400).json({ error: "word required" });
    const { learning, native } = settings.languages || { learning: "en", native: "zh" };
    const system = (settings.prompts?.dictLlm || DEFAULT_DICT_LLM_PROMPT)
      .replaceAll("{WORD}", word)
      .replaceAll("{L}", learning)
      .replaceAll("{N}", native);
    const content = await chatWithLLM(
      [
        { role: "system", content: system },
        { role: "user", content: `Headword: ${word}` },
      ],
      resolveLlm(settings)
    );
    res.json({ content });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Pronunciation audio — served from the companion .mdd resource file.
// The audio reference (e.g. sound://uk/run__gb_1.mp3) is mapped to the .mdd key.
app.get("/api/dict/audio", (req, res) => {
  const ref = String(req.query.ref || "").trim();
  if (!ref) return res.status(400).json({ error: "ref required" });
  const found = mddLookup(ref);
  if (!found) {
    return res
      .status(404)
      .json({ error: "audio resource not found in .mdd: " + ref });
  }
  try {
    const def = found.def;
    // js-mdict returns binary resources (audio/images) as base64-encoded strings,
    // so decode accordingly; raw Buffers (if any) pass through unchanged.
    const buf = Buffer.isBuffer(def)
      ? def
      : Buffer.from(def as string, "base64");
    const ext = (found.key.split(".").pop() || "mp3").toLowerCase();
    const ct: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      spx: "audio/ogg",
      flac: "audio/flac",
    };
    res.set("Content-Type", ct[ext] || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch (e) {
    console.error("[mdict] audio lookup error", ref, e);
    return res.status(500).json({ error: "audio decode failed" });
  }
});

// --- Sentence grammar / structure analysis (mirrors Enjoy analyze.command SYSTEM_PROMPT) ---
const DEFAULT_GRAMMAR_PROMPT = `I speak {N}. You're my {L} coach. I'll provide {L} text, you'll help me analyze the sentence structure, grammar, and vocabulary/phrases, and provide a detailed explanation of the text. Please return the results in the following format (but in {N}):

### Sentence Structure
(Explain each element of the sentence)

### Grammar
(Explain the grammar of the sentence)

### Vocabulary/Phrases
(Explain the key vocabulary and phrases used)`;

// Resolve a prompt: use the user's custom template if set, otherwise the
// built-in default. Substitute {L}/{N} with the chosen languages.
function promptFor(custom: string | undefined, fallback: string, L: string, N: string): string {
  const tpl = custom && custom.trim() ? custom : fallback;
  return tpl.replaceAll("{L}", L).replaceAll("{N}", N);
}

// (Word lookup is now served by the offline MDict engine above — no LLM.)



// Sentence-level grammar / structure analysis
app.post("/api/llm/analyze", async (req, res) => {
  try {
    const settings = readSettings();
    const text = (req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });
    const { learning, native } = settings.languages || { learning: "en", native: "zh" };
    const system = promptFor(settings.prompts?.grammar, DEFAULT_GRAMMAR_PROMPT, learning, native);
    const content = await chatWithLLM(
      [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      resolveLlm(settings)
    );
    res.json({ content });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/models/ensure", async (req, res) => {
  try {
    const pkg = sttPackageName(req.body.model || "tiny");
    await ensureModel(pkg);
    res.json({ ok: true, package: pkg });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tts/voices", async (_req, res) => {
  try {
    res.json(await getKokoroVoices());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/models/ensure-kokoro", async (req, res) => {
  try {
    const model = req.body.model || "82m-v1.0-quantized";
    const pkgs = await ensureKokoro(model);
    res.json({ ok: true, packages: pkgs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Quick engine tests — try a real run and report success/failure.
app.post("/api/engines/stt/test", async (req, res) => {
  try {
    const settings = readSettings();
    const pkg = sttPackageName(settings.engines.stt.model);
    await ensureModel(pkg);
    res.json({ ok: true, model: settings.engines.stt.model });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Text import — upload a file or paste a URL to create a "read" resource.
app.post("/api/import/text", upload.single("file"), async (req, res) => {
  try {
    let content = "";
    let name = req.body.name || "";
    if (req.file) {
      content = fs.readFileSync(req.file.path, "utf8").slice(0, 500_000);
      name = name || req.file.originalname;
    } else if (req.body.url) {
      const r = await fetch(req.body.url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
      const html = await r.text();
      // Strip HTML tags + scripts/styles, keep plain text.
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        // Decode common HTML entities instead of blanking them out.
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&(#0?39|apos);/gi, "'")
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500_000);
      name = name || new URL(req.body.url).hostname;
    }
    if (!content) return res.status(400).json({ error: "No content — upload a file or provide a URL." });
    const id = genId();
    const row: any = {
      id, type: "read", name, filename: req.file ? req.file.originalname : name,
      relativePath: req.file ? `read/${req.file.filename}` : "", size: Buffer.byteLength(content),
      duration: null, mimeType: "text/plain",
      transcript: content, words: "", note: "",
      createdAt: now(), updatedAt: now(),
    };
    db.prepare(
      `INSERT INTO resources(id,type,name,filename,relativePath,size,duration,mimeType,transcript,words,note,createdAt,updatedAt)
       VALUES(@id,@type,@name,@filename,@relativePath,@size,@duration,@mimeType,@transcript,@words,@note,@createdAt,@updatedAt)`
    ).run(row);
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/engines/tts/test", async (req, res) => {
  try {
    const settings = readSettings();
    // Test the on-screen form config when supplied, else the saved default.
    const live = settings.engines?.tts || {};
    const t = req.body?.config ? buildTtsConfig(req.body.config, live) : resolveTts(settings);
    // Test is always real-time (no file persisted) — pass save:false.
    await synthesizeSpeech("test", {
      engine: t.engine as any,
      voice: t.voice || undefined,
      baseUrl: t.baseUrl || undefined,
      apiKey: t.apiKey || undefined,
      model: t.model || undefined,
      kokoroModel: (t.kokoroModel || "82m-v1.0-quantized") as any,
      fishModel: t.fishModel || undefined,
      maleVoice: t.maleVoice || undefined,
      femaleVoice: t.femaleVoice || undefined,
      save: false,
    });
    res.json({ ok: true, engine: t.engine });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/engines/llm/test", async (req, res) => {
  try {
    const settings = readSettings();
    // Test the on-screen form config when supplied, else the saved default.
    const cfg = req.body?.config ? req.body.config : resolveLlm(settings);
    const reply = await chatWithLLM([{ role: "user", content: "hi" }], cfg);
    res.json({ ok: true, engine: cfg.engine, model: cfg.model, preview: reply.slice(0, 80) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Serve saved TTS audio (only written when the user opts in) + static SPA.
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
  console.log(`[lingo] server on http://localhost:${PORT}`);
  console.log(`[lingo] library: ${getLibraryPath()}`);
});
