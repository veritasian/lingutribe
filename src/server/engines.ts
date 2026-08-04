import { recognize, synthesize } from "echogarden";
import { encodeRawAudioToWave } from "echogarden/dist/audio/AudioUtilities.js";
import { loadPackage } from "echogarden/dist/utilities/PackageManager.js";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { ttsDir } from "./db.js";

/** Run curl — system proxy works automatically, no Node.js proxy hell.
 *  Returns raw stdout buffer + HTTP status code.
 *  IMPORTANT: uses encoding:"buffer" so binary bodies (MP3/WAV audio) are
 *  NOT corrupted by utf8 round-tripping. The HTTP status code is appended
 *  by curl after a trailing "\n" (-w), so we split at the LAST newline. */
function curl(args: string[]): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const all = ["-sS", "--max-time", "120", ...args, "-w", "\n%{http_code}"];
    execFile(
      "curl",
      all,
      { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
        if (err && buf.length === 0)
          return reject(new Error((err as any)?.message || "curl failed"));
        const nl = buf.lastIndexOf(0x0a); // last "\n" — added by our -w flag
        if (nl < 0) return reject(new Error("curl: malformed response"));
        const code = parseInt(buf.subarray(nl + 1).toString("utf8").trim(), 10) || 0;
        resolve({ stdout: buf.subarray(0, nl), code });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Speech-to-Text (echogarden / Whisper)
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
  language = "en"
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
// Text-to-Speech (Kokoro locally via echogarden; optional Fish/OpenAI endpoint)
// ---------------------------------------------------------------------------
export async function synthesizeSpeech(
  text: string,
  opts: {
    engine: "openai" | "kokoro" | "fish";
    voice?: string;
    language?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    kokoroModel?: "82m-v1.0-fp32" | "82m-v1.0-quantized";
    kokoroVoice?: string;
    fishModel?: string;
    maleVoice?: string;
    femaleVoice?: string;
    /** When true, write to the library's tts folder and return the path.
     *  When false (default for Read-aloud), return the audio inline as a
     *  data URL so nothing is persisted to disk. */
    save?: boolean;
  }
): Promise<{ url?: string; dataUrl?: string }> {
  // Voice resolution: an explicit voice (from the Read page / default saved
  // config) wins; otherwise pick randomly between male/female voices.
  const pickVoice = (): string | undefined => {
    if (opts.voice) return opts.voice;
    const cands = [opts.maleVoice, opts.femaleVoice].filter(Boolean) as string[];
    if (!cands.length) return undefined;
    return cands[Math.floor(Math.random() * cands.length)];
  };

  // Fish returns MP3 (we request format:"mp3") — everything else is WAV.
  const ext = opts.engine === "fish" ? "mp3" : "wav";
  const mime = ext === "mp3" ? "audio/mpeg" : "audio/wav";
  const outName = `tts-${Date.now()}.${ext}`;

  // Helper: persist to the tts folder (when saving) or return inline dataUrl.
  const finish = (buf: Buffer): { url?: string; dataUrl?: string } => {
    if (opts.save) {
      const outPath = path.join(ttsDir(), outName);
      fs.writeFileSync(outPath, buf);
      return { url: `/api/audio/${outName}` };
    }
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  };

  if (opts.engine === "fish") {
    const fishModel = opts.fishModel || "s2.1-pro-free";
    const refId = pickVoice();
    const body = JSON.stringify({ text, format: "mp3", ...(refId ? { reference_id: refId } : {}) });
    const fishUrl = (opts.baseUrl && opts.baseUrl.trim())
      ? opts.baseUrl.trim().replace(/\/$/, "")
      : "https://api.fish.audio/v1/tts";
    const { stdout, code } = await curl([
      "-X", "POST",
      "-H", `Authorization: Bearer ${opts.apiKey || ""}`,
      "-H", "Content-Type: application/json",
      "-H", `model: ${fishModel}`,
      "-d", body,
      fishUrl,
    ]);
    if (code >= 400) throw new Error(`Fish Audio TTS failed: ${code} ${stdout.toString().slice(0, 300)}`);
    return finish(stdout);
  }

  if (opts.engine === "openai") {
    const url = `${opts.baseUrl?.replace(/\/$/, "")}/audio/speech`;
    const body = JSON.stringify({
      model: opts.model || "tts-1",
      voice: pickVoice() || "alloy",
      input: text,
      response_format: "wav",
    });
    const { stdout, code } = await curl([
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-H", `Authorization: Bearer ${opts.apiKey || ""}`,
      "-d", body,
      url,
    ]);
    if (code >= 400) throw new Error(`TTS request failed: ${code} ${stdout.toString().slice(0, 200)}`);
    return finish(stdout);
  }

  // Local Kokoro (neural, onnx) via echogarden — downloads model + voices on first use.
  if (opts.engine === "kokoro") {
    const picked = pickVoice() || opts.kokoroVoice;
    // echogarden needs the full voice id (e.g. "en-US-Heart"); bare base names
    // like "Heart" are rejected with "No matching voice found". Only pass a
    // full id, otherwise let echogarden select its English default.
    const voiceArg = picked && picked.includes("-") ? picked : undefined;
    let result: any;
    try {
      result = await synthesize(text, {
        engine: "kokoro",
        voice: voiceArg,
        language: opts.language || "en",
        kokoro: { model: opts.kokoroModel || "82m-v1.0-quantized", provider: "cpu" },
      });
    } catch (e) {
      throw new Error(friendlyDownloadError(e));
    }
    // synthesize() returns { audio: RawAudio, timeline, language, voice }
    // where RawAudio = { audioChannels: Float32Array[], sampleRate }.
    const wavBuffer = encodeRawAudioToWave(result.audio, 16);
    return finish(Buffer.from(wavBuffer));
  }

  // Local espeak was removed — Kokoro is the local neural engine.
  // (Fallback: treat anything else as Kokoro.)
  const result: any = await synthesize(text, {
    engine: "kokoro",
    language: opts.language || "en",
    voice: pickVoice() || opts.kokoroVoice || "Heart",
    kokoro: { model: opts.kokoroModel || "82m-v1.0-quantized", provider: "cpu" },
  });
  const wavBuffer = encodeRawAudioToWave(result.audio, 16);
  return finish(Buffer.from(wavBuffer));
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

/** Turn echogarden's cryptic download errors into an actionable message. */
function friendlyDownloadError(e: any): string {
  const msg = String(e?.message || e);
  if (/status code (40[0-9]|50[0-9])|ENOTFOUND|ECONNREFUSED|fetch failed|ETIMEDOUT|network|certificate/i.test(msg)) {
    return `Model download failed: cannot reach HuggingFace (huggingface.co). Check your internet connection — some networks or sandboxes block HF. (${msg})`;
  }
  return msg;
}

/** Download an echogarden model package. Resolves when ready. */
export async function ensureModel(packageName: string): Promise<void> {
  try {
    await loadPackage(packageName);
  } catch (e) {
    throw new Error(friendlyDownloadError(e));
  }
}

// --- Kokoro (neural TTS, fully local) ---
const KOKORO_MODELS: Record<string, string> = {
  "82m-v1.0-fp32": "kokoro-82m-v1.0-fp32",
  "82m-v1.0-quantized": "kokoro-82m-v1.0-quantized",
};
const KOKORO_VOICES_PACKAGE = "kokoro-82m-v1.0-voices";

export function kokoroPackages(model: string): string[] {
  return [
    KOKORO_MODELS[model] || KOKORO_MODELS["82m-v1.0-quantized"],
    KOKORO_VOICES_PACKAGE,
  ];
}

/** Download the Kokoro model + voices packages (one-time, then offline). */
export async function ensureKokoro(model: string): Promise<string[]> {
  const pkgs = kokoroPackages(model);
  try {
    for (const pkg of pkgs) await loadPackage(pkg);
  } catch (e) {
    throw new Error(friendlyDownloadError(e));
  }
  return pkgs;
}

export interface KokoroVoice {
  name: string;
  language: string;
  gender: string;
}

/** List available Kokoro voices (name is what echogarden's synthesize expects). */
export async function getKokoroVoices(): Promise<KokoroVoice[]> {
  const mod: any = await import("echogarden/dist/synthesis/KokoroTTS.js");
  return (mod.voiceList as any[]).map((v) => ({
    name: v.name,
    language: v.languages?.[0] || "en",
    gender: v.gender,
  }));
}

// ---------------------------------------------------------------------------
// LLM (ollama / OpenAI-compatible)
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatWithLLM(
  messages: ChatMessage[],
  settings: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  },
  opts?: { json?: boolean }
): Promise<string> {
  const url = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const bodyObj: any = { model: settings.model, messages, stream: false };
  if (opts?.json) {
    if (/ollama|11434/.test(settings.baseUrl)) bodyObj.format = "json";
    else bodyObj.response_format = { type: "json_object" };
  }
  const body = JSON.stringify(bodyObj);
  const headers = [
    "-H", "Content-Type: application/json",
    ...(settings.apiKey ? ["-H", `Authorization: Bearer ${settings.apiKey}`] : []),
  ];
  const { stdout, code } = await curl(["-X", "POST", ...headers, "-d", body, url]);
  if (code >= 400) throw new Error(`LLM request failed (${code}): ${stdout.toString().slice(0, 200)}`);
  const raw = stdout.toString();
  if (!raw.trim()) {
    throw new Error(`LLM endpoint returned an empty response — cannot connect to ${url}. Is the server running and reachable?`);
  }
  const data = JSON.parse(raw);
  return data?.choices?.[0]?.message?.content || "";
}
