import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
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
import { transcribeFile } from "./engines/index.js";
import {
  readAnalysisCache,
  writeAnalysisCache,
  fingerprintFile,
  probeDuration,
  computePeaks,
  buildSegmentsFromWords,
  type AnalysisCache,
} from "./analysis.js";
import { collapseRepetition } from "./segments.js";
import { findFfmpeg } from "./util-ffmpeg.js";
import type { Segment } from "./segments.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWordsRoutes } from "./routes/words.js";
import { registerNotesRoutes } from "./routes/notes.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerEngineRoutes } from "./routes/engines.js";
import { registerDictRoutes } from "./routes/dict.js";

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
  // Guard: if this resource already carries a transcript (e.g. an imported
  // YouTube video with its own captions/subtitles), do NOT run speech
  // recognition again. Re-STT-ing already-subtitled media is redundant and
  // risks re-introducing engine loop-repetition artifacts into otherwise clean
  // caption text (the earlier "repeated sentences" bug). Only transcribe when
  // there is genuinely no transcript yet.
  const existingTranscript = (row.transcript || "").toString().trim();
  if (existingTranscript.length > 0) {
    const existingWords =
      typeof row.words === "string" ? JSON.parse(row.words || "[]") : row.words || [];
    res.json({
      transcript: row.transcript,
      words: existingWords,
      skipped: true,
      reason: "already_has_subtitles",
    });
    return;
  }
  try {
    const settings = readSettings();
    const result = await transcribeFile(
      fp,
      settings.engines.stt.model,
      req.body.language || "en"
    );
    // STT engines (Whisper/echogarden) occasionally loop during silence or
    // "[music]" tags, emitting verbatim repeated word-runs. Collapse those once
    // so the stored transcript/words read like a clean authored caption. Only
    // rebuild the transcript text from words when we actually have word
    // timings — otherwise keep the engine's own transcript.
    const rawWords = (result.words || []) as { text: string; start: number; end: number }[];
    const words = rawWords.length
      ? collapseRepetition(rawWords as any)
      : rawWords;
    const transcript = rawWords.length
      ? words.map((w: any) => w.text).join(" ")
      : (result.transcript || "");
    db.prepare("UPDATE resources SET transcript=?, words=?, updatedAt=? WHERE id=?").run(
      transcript,
      JSON.stringify(words),
      now(),
      req.params.id
    );
    // Pre-compute analysis cache so subsequent opens load instantly.
    try {
      const fpStat = await fingerprintFile(fp);
      const segs = buildSegmentsFromWords(words);
      let peaks: number[] = [];
      let duration = 0;
      try {
        const out = await computePeaks(fp);
        peaks = out.peaks;
        duration = out.duration;
      } catch (pe) {
        // ffmpeg decode failed — keep an empty peaks array, fall back to
        // duration probe.
        try { duration = await probeDuration(fp); } catch { /* ignore */ }
        console.warn("[analysis] peaks failed:", (pe as Error).message);
      }
      const cache: AnalysisCache = {
        version: 3,
        resourceId: req.params.id,
        md5: fpStat,
        createdAt: new Date().toISOString(),
        duration: duration || (segs[segs.length - 1]?.endTime ?? 0),
        durationProbedAt: Date.now(),
        transcript,
        words,
        segments: segs,
        peaks,
        peaksPerSec: 100,
      };
      await writeAnalysisCache(cache);
    } catch (e: any) {
      console.warn("[analysis] cache write failed:", e.message);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/resources/:id/analysis
 *
 * Returns the pre-computed analysis (peaks, segments, transcript, duration)
 * for a resource, or 404 if not yet cached. The renderer uses this on open:
 *   - peaks + duration → wavesurfer.load(url, peaks, duration) (skip decode)
 *   - segments          → subtitle list (#1 #2 #3 …) without recompute
 *
 * If words are in the DB but the cache file is missing/stale, the server
 * regenerates the cache synchronously (skipping peaks if ffmpeg fails).
 */
app.get("/api/resources/:id/analysis", async (req, res) => {
  const row = db.prepare("SELECT * FROM resources WHERE id=?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const fp = resolveResourceFile(row.relativePath);
  if (!fp) return res.status(404).json({ error: "file missing" });
  try {
    const fpStat = await fingerprintFile(fp);
    const r = await readAnalysisCache(req.params.id, fpStat);
    if (r.status === "hit") {
      return res.json(r.data);
    }
    // Cache miss — regenerate if we have word data to segment.
    const wordsRaw = row.words as string | null;
    const words: { text: string; start: number; end: number }[] = wordsRaw
      ? (JSON.parse(wordsRaw) as any[])
      : [];
    const segs = buildSegmentsFromWords(words);
    let peaks: number[] = [];
    let duration = 0;
    try {
      const out = await computePeaks(fp);
      peaks = out.peaks;
      duration = out.duration;
    } catch {
      try { duration = await probeDuration(fp); } catch { /* ignore */ }
    }
    const cache: AnalysisCache = {
      version: 3,
      resourceId: req.params.id,
      md5: fpStat,
      createdAt: new Date().toISOString(),
      duration: duration || (segs[segs.length - 1]?.endTime ?? 0),
      durationProbedAt: Date.now(),
      transcript: row.transcript || "",
      words,
      segments: segs,
      peaks,
      peaksPerSec: 100,
    };
    await writeAnalysisCache(cache);
    res.json(cache);
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

// Returns the original subtitle cues (text + their own start/end times) as the
// canonical segments, plus the per-word tokens (evenly distributed across each
// cue's time range) used for word-level sync. Keeping the *original* cues means
// an imported YouTube/video subtitle is shown exactly as authored — its own
// text and timing — rather than being re-segmented.
function parseSubtitlesFile(fp: string): {
  transcript: string;
  words: ImpWord[];
  segments: Segment[];
} | null {
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
  // Sort by start time, build transcript + words + original-cue segments.
  const sorted = [...byRange.values()].sort((a, b) => a.start - b.start);
  const words: ImpWord[] = [];
  const segments: Segment[] = [];
  const parts: string[] = [];
  let wi = 0; // running word index across all cues
  for (const cue of sorted) {
    parts.push(cue.text);
    const toks = cue.text.split(/\s+/).filter(Boolean);
    const n = toks.length || 1;
    const startIdx = wi;
    toks.forEach((tk, i) => {
      words.push({
        text: tk,
        start: +(cue.start + ((cue.end - cue.start) * i) / n).toFixed(2),
        end: +(cue.start + ((cue.end - cue.start) * (i + 1)) / n).toFixed(2),
      });
      wi++;
    });
    const endIdx = wi - 1;
    segments.push({
      index: segments.length,
      number: segments.length + 1,
      text: cue.text,
      startTime: cue.start,
      endTime: cue.end,
      wordStartIdx: startIdx,
      wordEndIdx: endIdx,
    });
  }
  if (!words.length) return null;
  return { transcript: parts.join(" "), words, segments };
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
    let subs: { transcript: string; words: ImpWord[]; segments?: Segment[] } | null = null;

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

    // Pre-compute analysis cache now so the resource opens instantly on first
    // view — same flow as the transcribe endpoint (peaks + segments + duration).
    const destFp = path.join(typeDir(type), destName);
    if (subs && subs.words && subs.words.length > 0) {
      try {
        const fpStat = await fingerprintFile(destFp);
        const segs =
          subs.segments && subs.segments.length
            ? subs.segments
            : buildSegmentsFromWords(subs.words as any);
        let peaks: number[] = [];
        let duration = 0;
        try {
          const out = await computePeaks(destFp);
          peaks = out.peaks;
          duration = out.duration;
        } catch {
          try { duration = await probeDuration(destFp); } catch { /* ignore */ }
        }
        const cache: AnalysisCache = {
          version: 3,
          resourceId: id,
          md5: fpStat,
          createdAt: new Date().toISOString(),
          duration: duration || (segs[segs.length - 1]?.endTime ?? 0),
          durationProbedAt: Date.now(),
          transcript: subs.transcript || "",
          words: subs.words as any,
          segments: segs,
          peaks,
          peaksPerSec: 100,
        };
        await writeAnalysisCache(cache);
      } catch (e: any) {
        console.warn("[analysis] url-import cache write failed:", e.message);
      }
    }

    res.json({ ...row, words: subs ? subs.words : [] });
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
  console.log(`[lingutribe] server on http://localhost:${PORT}`);
  console.log(`[lingutribe] library: ${getLibraryPath()}`);
});
