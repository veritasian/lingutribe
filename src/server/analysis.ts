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
 * Compute duration in seconds using ffprobe-style invocation. Resolves as soon
 * as ffmpeg prints the "Duration:" line and kills the process — decoding the
 * whole file just to read a header would otherwise block on hours-long audio.
 */
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
    let done = false;
    const finish = (sec: number) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      p.kill(); // no need to finish decoding just for a duration probe
      resolve(sec);
    };
    // Hard cap so an unreadable/corrupt file can't hang the request.
    const timeout = setTimeout(() => finish(0), 15_000);
    p.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      // "Duration: HH:MM:SS.xx"
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (m) finish(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    p.on("close", () => finish(0));
    p.on("error", () => finish(0));
  });
}

/** Decode audio to raw mono float32 samples (8 kHz), compute peaks.
 *
 *  Streams: peaks are computed incrementally as chunks arrive so memory stays
 *  constant regardless of file length, and the ffmpeg child is killed on
 *  timeout so a stuck decode can't leak processes.
 */
export async function computePeaks(
  filePath: string,
  peaksPerSec: number = DEFAULT_PEAKS_PER_SEC
): Promise<{ peaks: number[]; duration: number }> {
  const ff = findFfmpeg();
  if (!ff) return { peaks: [], duration: 0 };
  const samplesPerPeak = Math.max(1, Math.floor(PEAK_SAMPLE_RATE / peaksPerSec));
  return new Promise<{ peaks: number[]; duration: number }>((resolve, reject) => {
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
    const peaks: number[] = [];
    let carry = Buffer.alloc(0);
    let totalSamples = 0;
    const timeout = setTimeout(() => {
      if (!p.killed) p.kill("SIGKILL");
      reject(new Error("computePeaks timeout 90s"));
    }, 90_000);
    p.stdout.on("data", (c: Buffer) => {
      carry = Buffer.concat([carry, c]);
      const samples = Math.floor(carry.length / 4);
      const usable = Math.floor(samples / samplesPerPeak) * samplesPerPeak;
      if (usable >= samplesPerPeak) {
        for (let s = 0; s < usable; s += samplesPerPeak) {
          let max = 0;
          for (let j = 0; j < samplesPerPeak; j++) {
            const v = Math.abs(carry.readFloatLE((s + j) * 4));
            if (v > max) max = v;
          }
          peaks.push(max > 1 ? 1 : max); // clamp (some encoders overshoot)
        }
        totalSamples += usable;
      }
      carry = carry.subarray(usable * 4);
    });
    p.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    p.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        return reject(new Error(`ffmpeg exit ${code}`));
      }
      const duration = totalSamples / PEAK_SAMPLE_RATE;
      resolve({ peaks, duration });
    });
  });
}

export function buildSegmentsFromWords(words: WordEntry[]): Segment[] {
  return buildSegments(words);
}
