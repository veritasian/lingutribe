import { recognize } from "echogarden";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { curl, friendlyDownloadError } from "./http.js";

// ---------------------------------------------------------------------------
// Speech-to-Text
//
// Two interchangeable backends, selected by settings.engines.stt.engine:
//   - "echogarden" (Whisper)  — default, broad language coverage, word timeline
//   - "moonshine"             — faster + smaller for English, no word timeline
// Both auto-install their model on first use (mirrors Whisper's ensureModel).
// ---------------------------------------------------------------------------
export interface TranscribeResult {
  transcript: string;
  words?: { text: string; start: number; end: number }[];
}

/** Map UI model names to echogarden WhisperModelName values.
 *  ("large" is not a valid whisper model name — it maps to large-v3-turbo,
 *  matching the STT_PACKAGES download mapping below.) */
const WHISPER_MODEL_NAMES: Record<string, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  large: "large-v3-turbo",
};

export async function transcribeFile(
  filePath: string,
  model = "tiny",
  language = "en",
  engine: "echogarden" | "moonshine" = "echogarden"
): Promise<TranscribeResult> {
  if (engine === "moonshine") return transcribeMoonshine(filePath, model);
  return transcribeWhisper(filePath, model, language);
}

// ---------------------------------------------------------------------------
// Backend A — echogarden / Whisper
// ---------------------------------------------------------------------------
async function transcribeWhisper(
  filePath: string,
  model: string,
  language: string
): Promise<TranscribeResult> {
  let result: any;
  try {
    result = await recognize(filePath, {
      engine: "whisper",
      language,
      // The model MUST be nested under whisper.* — a top-level "model" key is
      // silently ignored by echogarden (the selected model would never apply).
      whisper: { model: (WHISPER_MODEL_NAMES[model] || "tiny") as any },
    });
  } catch (e) {
    throw new Error(friendlyDownloadError(e));
  }
  const words = (result.wordTimeline as any[])?.map((w) => ({
    text: w.text,
    start: w.startTime ?? w.start,
    end: w.endTime ?? w.end,
  }));
  return { transcript: result.transcript || "", words };
}

// ---------------------------------------------------------------------------
// Backend B — Moonshine (sherpa-onnx-node)
// ---------------------------------------------------------------------------

/** Moonshine models (sherpa-onnx packaging). English int8 are the smallest and
 *  fastest; v2 multilingual bases exist but English is this app's focus.
 *  `urls` lists download sources in priority order. GitHub releases is the
 *  canonical host (Hugging Face / ModelScope mirrors for this model 404/401, so
 *  only GitHub is used). The downloader tries each until one yields a valid
 *  bzip2 archive. */
export const MOONSHINE_MODELS: Record<
  string,
  { dir: string; urls: string[] }
> = {
  tiny: {
    dir: "sherpa-onnx-moonshine-tiny-en-int8",
    urls: [
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2",
    ],
  },
  base: {
    dir: "sherpa-onnx-moonshine-base-en-int8",
    urls: [
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2",
    ],
  },
};

const MOONSHINE_FILES = [
  "preprocess.onnx",
  "encode.int8.onnx",
  "uncached_decode.int8.onnx",
  "cached_decode.int8.onnx",
  "tokens.txt",
];

/** Cache location. Prod: ~/Library/Application Support/lingutribe/models/moonshine/<dir>.
 *  Dev fallback: data/models/moonshine/<dir> (already gitignored). */
export function resolveMoonshineModelDir(model: string): string {
  const key = MOONSHINE_MODELS[model] ? model : "tiny";
  const dirName = MOONSHINE_MODELS[key].dir;
  if (process.env.LINGUTRIBE_MODELS_DIR) {
    return path.join(process.env.LINGUTRIBE_MODELS_DIR, "moonshine", dirName);
  }
  const appSupport =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".local", "share");
  return path.join(appSupport, "lingutribe", "models", "moonshine", dirName);
}

/** Download + extract a Moonshine model if not already present. Safe to call
 *  repeatedly — skips when all required files exist (idempotent, like
 *  echogarden's loadPackage). Tries each mirror in MOONSHINE_MODELS[].urls. */
export async function ensureMoonshineModel(model: string): Promise<string> {
  const key = MOONSHINE_MODELS[model] ? model : "tiny";
  const { dir, urls } = MOONSHINE_MODELS[key];
  const modelDir = resolveMoonshineModelDir(key);
  if (MOONSHINE_FILES.every((f) => fs.existsSync(path.join(modelDir, f)))) {
    return modelDir;
  }
  fs.mkdirSync(modelDir, { recursive: true });
  const tarball = path.join(modelDir, `${dir}.tar.bz2`);

  let lastErr = "no mirrors attempted";
  for (const url of urls) {
    try {
      // Longer timeout for the tarball; our --max-time overrides the helper's
      // default because curl honors the last --max-time on the command line.
      const { code } = await curl([
        "--max-time",
        "600",
        "-L",
        "-o",
        tarball,
        url,
      ]);
      if (code !== 200 || !fs.existsSync(tarball)) {
        lastErr = `HTTP ${code} from ${url}`;
        continue;
      }
      // Guard against an HTML error page / truncated body pretending to be a tarball.
      const head = Buffer.alloc(3);
      const fd = fs.openSync(tarball, "r");
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      if (head.toString("latin1") !== "BZh") {
        lastErr = `downloaded file from ${url} is not a bzip2 archive (corrupt/blocked)`;
        continue;
      }
      await extractTar(tarball, modelDir);
      // sherpa-onnx release tarballs nest everything under a top-level
      // <dir>/ folder; flatten it so the model files land directly in modelDir
      // (which is what transcribeMoonshine expects). No-op if already flat.
      const nested = path.join(modelDir, dir);
      if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
        for (const f of fs.readdirSync(nested)) {
          fs.renameSync(path.join(nested, f), path.join(modelDir, f));
        }
        fs.rmSync(nested, { recursive: true, force: true });
      }
      const missing = MOONSHINE_FILES.filter(
        (f) => !fs.existsSync(path.join(modelDir, f))
      );
      if (missing.length) {
        lastErr = `extraction from ${url} incomplete — missing: ${missing.join(", ")}`;
        continue;
      }
      fs.rmSync(tarball, { force: true });
      return modelDir;
    } catch (e: any) {
      lastErr = `${url}: ${e.message}`;
    }
  }
  throw new Error(
    `Moonshine model (${key}) download/extract failed after trying ${urls.length} mirror(s): ${lastErr}`
  );
}

/** Extract a .tar.bz2 via the system tar (macOS bsdtar supports bz2 natively;
 *  on Linux ensure bzip2 is installed). */
function extractTar(tarball: string, dest: string): Promise<void> {
  return new Promise((res, rej) =>
    execFile("tar", ["xjf", tarball, "-C", dest], (e) =>
      e
        ? rej(
            new Error(
              `tar xjf failed: ${e.message}. macOS bsdtar supports bz2; on Linux ensure bzip2 is installed.`
            )
          )
        : res()
    )
  );
}

async function transcribeMoonshine(
  filePath: string,
  model: string
): Promise<TranscribeResult> {
  const modelDir = await ensureMoonshineModel(model); // auto-install on first use
  const sherpaMod = await import("sherpa-onnx-node");
  // CJS package: the constructor lives on .default when imported via ESM interop.
  const sherpa = ((sherpaMod as any).default ?? sherpaMod) as any;

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      moonshine: {
        preprocessor: path.join(modelDir, "preprocess.onnx"),
        encoder: path.join(modelDir, "encode.int8.onnx"),
        uncachedDecoder: path.join(modelDir, "uncached_decode.int8.onnx"),
        cachedDecoder: path.join(modelDir, "cached_decode.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      numThreads: Math.max(1, os.cpus().length - 1),
      debug: false,
      provider: "cpu",
    },
  });

  const wave = (sherpa as any).readWave(filePath);
  const stream = recognizer.createStream();
  // sherpa-onnx-node's acceptWaveform takes a single {samples, sampleRate} object.
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  // Tail padding (0.2s) — recommended by sherpa-onnx for Moonshine.
  const tail = new Float32Array(Math.round(wave.sampleRate * 0.2));
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: tail });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);

  const transcript: string = result?.text?.trim() || "";
  // Moonshine's Node result exposes {text, tokens} but not reliable per-word
  // timestamps. Fall back to an even per-word split across the utterance so the
  // read-along UI still highlights progressively. Whisper remains the
  // high-precision option when exact word timing matters.
  const tokens: string[] = Array.isArray(result?.tokens) ? result.tokens : [];
  let words: { text: string; start: number; end: number }[] | undefined;
  if (tokens.length) {
    const dur = wave.samples.length / wave.sampleRate;
    const step = dur / tokens.length;
    words = tokens.map((t, i) => ({
      text: t,
      start: +(i * step).toFixed(3),
      end: +((i + 1) * step).toFixed(3),
    }));
  }
  return { transcript, words };
}

// ---------------------------------------------------------------------------
// Model download (echogarden native package manager — guaranteed correct)
// ---------------------------------------------------------------------------
const STT_PACKAGES: Record<string, string> = {
  tiny: "whisper-tiny-20231126",
  base: "whisper-base-20231126",
  small: "whisper-small-20231126",
  medium: "whisper-medium-20231126",
  large: "whisper-large-v3-turbo-fp16-20231126",
};

export function sttPackageName(model: string): string {
  return STT_PACKAGES[model] || STT_PACKAGES.tiny;
}
