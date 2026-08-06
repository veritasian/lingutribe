// Resource routes — CRUD + transcribe + analysis cache.
import express from "express";
import fs from "fs";
import path from "path";
import { getDb, genId, typeDir, resolveResourceFile } from "../db.js";
import { transcribeFile } from "../engines/index.js";
import { collapseRepetition } from "../segments.js";
import {
  readAnalysisCache,
  writeAnalysisCache,
  fingerprintFile,
  probeDuration,
  computePeaks,
  buildSegmentsFromWords,
  type AnalysisCache,
} from "../analysis.js";

interface ResourcesCtx {
  db: ReturnType<typeof getDb>;
  now: () => number;
  readSettings: () => any;
  upload: any;
}

export function registerResourcesRoutes(app: express.Express, ctx: ResourcesCtx) {
  const { db, now, readSettings, upload } = ctx;
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
}
