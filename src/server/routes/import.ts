// URL / text import routes (yt-dlp, RSS fallback, subtitle parsing).
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { getDb, genId, typeDir } from "../db.js";
import type { Segment } from "../segments.js";
import {
  writeAnalysisCache,
  fingerprintFile,
  probeDuration,
  computePeaks,
  buildSegmentsFromWords,
  type AnalysisCache,
} from "../analysis.js";

interface ImportCtx {
  db: ReturnType<typeof getDb>;
  now: () => number;
  upload: any;
  ffmpegPath: string | null;
}

/** Decode common HTML entities to their literal characters. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(#0?39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, " ");
}

/** Extract the page <title> (decoded, trimmed) or empty string. */
function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return decodeEntities(m[1]).replace(/\s+/g, " ").trim();
}

export function registerImportRoutes(app: express.Express, ctx: ImportCtx) {
  const { db, now, upload, ffmpegPath } = ctx;
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
      if (!r.ok) {
        return res.status(400).json({ error: `fetch failed (HTTP ${r.status})` });
      }
      const html = await r.text();
      // Use the page <title> as the resource name when none was supplied.
      name = name || pageTitle(html) || new URL(req.body.url).hostname;
      // Convert HTML to readable plain text while KEEPING the article's
      // structure: block-level elements become paragraph breaks, so the
      // imported news keeps its title/paragraph layout instead of collapsing
      // into one wall of text. The Read page renders double newlines as <p>.
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        // Normalize CRLF / CR to LF first so the \n{3,} collapse below works.
        .replace(/\r\n?/g, "\n")
        .replace(/<\/(p|h[1-6]|div|li|blockquote|section|article|header|footer|figure|ul|ol|pre|table|tr)>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, 500_000);
      content = decodeEntities(content);
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
    // Include the underlying cause (e.g. UND_ERR_CONNECT_TIMEOUT) so network
    // failures are diagnosable instead of a bare "fetch failed".
    const cause = e?.cause?.code || e?.cause?.message || "";
    res.status(500).json({ error: e.message + (cause ? ` (${cause})` : "") });
  }
});

}
