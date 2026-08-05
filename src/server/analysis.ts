/**
 * Per-resource "analysis" cache.
 *
 * Written once when STT completes (or when the user explicitly regenerates).
 * Read on every subsequent open so the renderer can boot with:
 *   - duration                 (no decode probe)
 *   - peaks[]                  (wavesurfer.load(url, peaks, duration))
 *   - segments[]               (subtitle UI list, #1 #2 #3 …)
 *   - transcript + words[]     (canonical text for the resource)
 *
 * File location: <library>/cache/analysis/<id>.json
 * (Library root is governed by LINGO_LIBRARY_DIR — see db.ts.)
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getLibraryPath, resourcesDir } from "./db.js";
import { findFfmpeg } from "./util-ffmpeg.js";
import { buildSegments, type Segment } from "./segments.js";

export interface WordEntry {
  text: string;
  start: number;
  end: number;
}

export interface AnalysisCache {
  version: 3;
  resourceId: string;
  md5: string;                       // content fingerprint (used to invalidate)
  createdAt: string;                 // ISO timestamp
  duration: number;                  // seconds
  durationProbedAt: number;          // ms (for diagnostics)
  transcript: string;
  words: WordEntry[];
  segments: Segment[];
  peaks: number[];                   // 0..1 normalized, ascending time
  peaksPerSec: number;               // sampling rate used
}

export type AnalysisReadResult =
  | { status: "hit"; data: AnalysisCache }
  | { status: "miss"; reason: "no-cache" | "stale-md5"; md5?: string };

const CACHE_VERSION = 3;

function cacheDir(): string {
  const d = path.join(getLibraryPath(), "cache", "analysis");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cachePath(resourceId: string): string {
  // Resource ids are alphanum + dashes (see db.genId) but sanitize anyway.
  const safe = resourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(cacheDir(), `${safe}.json`);
}

/** Cheap, stable content fingerprint: file size + mtime ms. */
export async function fingerprintFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.stat(absPath, (err, st) => {
      if (err) return reject(err);
      resolve(`${st.size}-${Math.floor(st.mtimeMs)}`);
    });
  });
}

/** Read the cache. Returns hit/miss, never throws. */
export async function readAnalysisCache(
  resourceId: string,
  currentMd5: string
): Promise<AnalysisReadResult> {
  const fp = cachePath(resourceId);
  if (!fs.existsSync(fp)) return { status: "miss", reason: "no-cache" };
  try {
    const raw = await fs.promises.readFile(fp, "utf8");
    const data = JSON.parse(raw) as AnalysisCache;
    if (data.version !== CACHE_VERSION) return { status: "miss", reason: "stale-md5" };
    if (currentMd5 && data.md5 !== currentMd5) {
      return { status: "miss", reason: "stale-md5", md5: data.md5 };
    }
    return { status: "hit", data };
  } catch {
    return { status: "miss", reason: "no-cache" };
  }
}

/** Write the cache. Atomic-ish: write to .tmp then rename. */
export async function writeAnalysisCache(data: AnalysisCache): Promise<void> {
  const fp = cachePath(data.resourceId);
  const tmp = fp + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, fp);
}

/* -----------------------------------------------------------------------
 * Decoding + peak computation.
 * Pipes audio → ffmpeg → raw mono float32 stream → groups of samples
 * → max abs per group → JSON-friendly peaks array.
 * --------------------------------------------------------------------- */

const DEFAULT_PEAKS_PER_SEC = 100;
const PEAK_SAMPLE_RATE = 8000; // 8 kHz is plenty for waveform display

/**
 * Run an async function with a hard timeout; if the timeout wins, reject.
 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_res, rej) => setTimeout(() => rej(new Error(`${tag} timeout ${ms}ms`)), ms)),
  ]);
}

/** Compute duration in seconds using ffprobe-style invocation. */
export async function probeDuration(filePath: string): Promise<number> {
  const ff = findFfmpeg();
  if (!ff) return 0;
  return new Promise((resolve) => {
    const p = spawn(
      ff,
      [
        "-i", filePath,
        "-f", "null",
        "-loglevel", "info",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", () => {
      // "Duration: HH:MM:SS.xx"
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return resolve(0);
      const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
      resolve(sec);
    });
    p.on("error", () => resolve(0));
  });
}

/** Decode audio to raw mono float32 samples (8 kHz), compute peaks. */
export async function computePeaks(
  filePath: string,
  peaksPerSec: number = DEFAULT_PEAKS_PER_SEC
): Promise<{ peaks: number[]; duration: number }> {
  const ff = findFfmpeg();
  if (!ff) return { peaks: [], duration: 0 };
  const samplesPerPeak = Math.max(1, Math.floor(PEAK_SAMPLE_RATE / peaksPerSec));
  const work = new Promise<{ peaks: number[]; duration: number }>((resolve, reject) => {
    const args = [
      "-i", filePath,
      "-f", "f32le",
      "-acodec", "pcm_f32le",
      "-ac", "1",
      "-ar", String(PEAK_SAMPLE_RATE),
      "-loglevel", "error",
      "-",
    ];
    const p = spawn(ff, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    p.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      totalBytes += c.length;
    });
    p.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0 && code !== null) {
        return reject(new Error(`ffmpeg exit ${code}`));
      }
      const buf = Buffer.concat(chunks);
      const total = buf.length / 4; // f32le = 4 bytes/sample
      const peaks: number[] = [];
      for (let i = 0; i + samplesPerPeak <= total; i += samplesPerPeak) {
        let max = 0;
        const end = i + samplesPerPeak;
        for (let j = i; j < end; j++) {
          const v = buf.readFloatLE(j * 4);
          const av = v < 0 ? -v : v;
          if (av > max) max = av;
        }
        peaks.push(max > 1 ? 1 : max); // clamp (some encoders overshoot)
      }
      const duration = total / PEAK_SAMPLE_RATE;
      resolve({ peaks, duration });
    });
  });
  return withTimeout(work, 90_000, "computePeaks");
}

export function buildSegmentsFromWords(words: WordEntry[]): Segment[] {
  return buildSegments(words);
}
