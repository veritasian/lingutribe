// ---------------------------------------------------------------------------
// Standalone Kokoro TTS — official deployment (https://github.com/hexgrad/kokoro)
//
// Uses the maintained JS library `kokoro-js` (KokoroTTS) backed by
// @huggingface/transformers + onnxruntime-node. The model is the official
// ONNX release `onnx-community/Kokoro-82M-v1.0-ONNX`, downloaded once to a
// local dir (no echogarden, no network at runtime). Voices ship inside the
// kokoro-js package (node_modules/kokoro-js/voices/*.bin).
//
// This is the canonical way to run Kokoro per its README:
//   const tts = await KokoroTTS.from_pretrained(modelDir, { dtype: "q8", device: "cpu" });
//   const audio = await tts.generate(text, { voice: "af_heart" });
// ---------------------------------------------------------------------------
import fs from "fs";
import os from "os";
import path from "path";

const SAMPLE_RATE = 24000;

// === Model location (modular: <models>/kokoro/official) =====================
export function kokoroModelDir(): string {
  if (process.env.LINGUTRIBE_MODELS_DIR)
    return path.join(process.env.LINGUTRIBE_MODELS_DIR, "kokoro", "official");
  const appSupport =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".local", "share");
  return path.join(appSupport, "lingutribe", "models", "kokoro", "official");
}

// === Voices (friendly names, kept compatible with UI + stored config) ======
export interface KokoroVoice {
  name: string;
  languages: string[];
  gender: "female" | "male" | "neutral";
}
const voiceList: KokoroVoice[] = [
  // US English
  { name: "Heart", languages: ["en-US", "en"], gender: "female" },
  { name: "Bella", languages: ["en-US", "en"], gender: "female" },
  { name: "Nicole", languages: ["en-US", "en"], gender: "female" },
  { name: "Aoede", languages: ["en-US", "en"], gender: "female" },
  { name: "Kore", languages: ["en-US", "en"], gender: "female" },
  { name: "Sarah", languages: ["en-US", "en"], gender: "female" },
  { name: "Nova", languages: ["en-US", "en"], gender: "female" },
  { name: "Sky", languages: ["en-US", "en"], gender: "female" },
  { name: "Alloy", languages: ["en-US", "en"], gender: "female" },
  { name: "Jessica", languages: ["en-US", "en"], gender: "female" },
  { name: "River", languages: ["en-US", "en"], gender: "female" },
  { name: "Michael", languages: ["en-US", "en"], gender: "male" },
  { name: "Fenrir", languages: ["en-US", "en"], gender: "male" },
  { name: "Puck", languages: ["en-US", "en"], gender: "male" },
  { name: "Echo", languages: ["en-US", "en"], gender: "male" },
  { name: "Eric", languages: ["en-US", "en"], gender: "male" },
  { name: "Liam", languages: ["en-US", "en"], gender: "male" },
  { name: "Onyx", languages: ["en-US", "en"], gender: "male" },
  { name: "Santa", languages: ["en-US", "en"], gender: "male" },
  { name: "Adam", languages: ["en-US", "en"], gender: "male" },
  // UK English
  { name: "Emma", languages: ["en-GB", "en"], gender: "female" },
  { name: "Isabella", languages: ["en-GB", "en"], gender: "female" },
  { name: "Alice", languages: ["en-GB", "en"], gender: "female" },
  { name: "Lily", languages: ["en-GB", "en"], gender: "female" },
  { name: "George", languages: ["en-GB", "en"], gender: "male" },
  { name: "Fable", languages: ["en-GB", "en"], gender: "male" },
  { name: "Lewis", languages: ["en-GB", "en"], gender: "male" },
  { name: "Daniel", languages: ["en-GB", "en"], gender: "male" },
  // Spanish (Spain)
  { name: "Dora", languages: ["es-ES", "es"], gender: "female" },
  { name: "Alex", languages: ["es-ES", "es"], gender: "male" },
  { name: "Santa", languages: ["es-ES", "es"], gender: "male" },
  // French (France)
  { name: "Siwis", languages: ["fr-FR", "fr"], gender: "female" },
  // Hindi (India)
  { name: "Alpha", languages: ["hi-IN", "hi"], gender: "female" },
  { name: "Beta", languages: ["hi-IN", "hi"], gender: "female" },
  { name: "Omega", languages: ["hi-IN", "hi"], gender: "male" },
  { name: "Psi", languages: ["hi-IN", "hi"], gender: "male" },
  // Italian (Italy)
  { name: "Sara", languages: ["it-IT", "it"], gender: "female" },
  { name: "Nicola", languages: ["it-IT", "it"], gender: "male" },
  // Portuguese (Brazil)
  { name: "Dora", languages: ["pt-BR", "pt"], gender: "female" },
  { name: "Alex", languages: ["pt-BR", "pt"], gender: "male" },
  { name: "Santa", languages: ["pt-BR", "pt"], gender: "male" },
  // Chinese (China)
  { name: "Xiaobei", languages: ["zh-CN", "zh"], gender: "female" },
  { name: "Xiaoni", languages: ["zh-CN", "zh"], gender: "female" },
  { name: "Xiaoxiao", languages: ["zh-CN", "zh"], gender: "female" },
  { name: "Xiaoyi", languages: ["zh-CN", "zh"], gender: "female" },
  { name: "Yunjian", languages: ["zh-CN", "zh"], gender: "male" },
  { name: "Yunxi", languages: ["zh-CN", "zh"], gender: "male" },
  { name: "Yunxia", languages: ["zh-CN", "zh"], gender: "male" },
  { name: "Yunyang", languages: ["zh-CN", "zh"], gender: "male" },
];

export function getKokoroVoices(): KokoroVoice[] {
  return voiceList;
}

// kokoro-js voice IDs look like `af_heart`, `am_michael`, `bf_emma`:
// <lang-prefix><gender-letter>_<lowercased name>.
const langPrefix: Record<string, string> = {
  "en-US": "a", "en-GB": "b", "es-ES": "e", "fr-FR": "f", "hi-IN": "h",
  "it-IT": "i", "ja-JP": "j", "pt-BR": "p", "zh-CN": "z",
};
function voiceIdToName(v: KokoroVoice): string {
  const p = langPrefix[v.languages[0]] || "a";
  const g = v.gender === "male" ? "m" : "f";
  return `${p}${g}_${v.name.toLowerCase()}`;
}

function findVoice(name?: string, language = "en"): KokoroVoice {
  const lower = (name || "").toLowerCase();
  const langShort = language.split("-")[0];
  const candidates = voiceList.filter(
    (v) =>
      v.languages.includes(language) ||
      v.languages.includes(langShort) ||
      v.languages.includes("en")
  );
  if (lower) {
    const exact = candidates.find((v) => v.name.toLowerCase() === lower);
    if (exact) return exact;
  }
  return candidates[0] || voiceList[0];
}

// === kokoro-js instance (lazy-loaded so the server boots fast) =============
let ttsInstance: any = null;
let ttsLoading: Promise<any> | null = null;
async function getTts(): Promise<any> {
  if (ttsInstance) return ttsInstance;
  if (!ttsLoading) {
    ttsLoading = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(kokoroModelDir(), {
        // config.json has no onnx mapping, so transformers.js defaults to
        // onnx/model.onnx (our local quantized weights).
        dtype: "fp32",
        device: "cpu", // onnxruntime-node — ~4x faster than wasm
      });
    })();
  }
  ttsInstance = await ttsLoading;
  return ttsInstance;
}

/** Synthesize text with the local Kokoro model. Returns 16-bit PCM WAV bytes. */
export async function synthesizeKokoro(
  text: string,
  opts: { voice?: string; language?: string; model?: string; speed?: number } = {}
): Promise<Buffer> {
  const voice = findVoice(opts.voice, opts.language || "en");
  const tts = await getTts();
  const audio = await tts.generate(text, {
    voice: voiceIdToName(voice),
    speed: opts.speed ?? 1,
  });
  return encodeWav(audio.audio as Float32Array, audio.sampling_rate || SAMPLE_RATE);
}

/** Ensure the official Kokoro model is present locally. */
export async function ensureKokoro(_model = "official"): Promise<void> {
  const dir = kokoroModelDir();
  const onnx = path.join(dir, "onnx", "model.onnx");
  if (!fs.existsSync(onnx))
    throw new Error(`Kokoro model not found at ${dir}. Expected onnx/model.onnx.`);
}

// === WAV encoder (16-bit PCM mono) =========================================
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  let o = 0;
  buffer.write("RIFF", o); o += 4;
  buffer.writeUInt32LE(36 + numSamples * 2, o); o += 4;
  buffer.write("WAVE", o); o += 4;
  buffer.write("fmt ", o); o += 4;
  buffer.writeUInt32LE(16, o); o += 4;
  buffer.writeUInt16LE(1, o); o += 2; // PCM
  buffer.writeUInt16LE(1, o); o += 2; // mono
  buffer.writeUInt32LE(sampleRate, o); o += 4;
  buffer.writeUInt32LE(sampleRate * 2, o); o += 4; // byte rate
  buffer.writeUInt16LE(2, o); o += 2; // block align
  buffer.writeUInt16LE(16, o); o += 2; // bits per sample
  buffer.write("data", o); o += 4;
  buffer.writeUInt32LE(numSamples * 2, o); o += 4;
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE((s * 32767) | 0, o);
    o += 2;
  }
  return buffer;
}
