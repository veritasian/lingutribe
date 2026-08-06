import { synthesize } from "echogarden";
import { encodeRawAudioToWave } from "echogarden/dist/audio/AudioUtilities.js";
import { loadPackage } from "echogarden/dist/utilities/PackageManager.js";
import fs from "fs";
import path from "path";
import { ttsDir } from "../db.js";
import { curl, friendlyDownloadError } from "./http.js";

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
