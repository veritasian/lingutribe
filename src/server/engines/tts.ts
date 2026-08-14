import fs from "fs";
import path from "path";
import { ttsDir } from "../db.js";
import { curl } from "./http.js";
import { synthesizeKokoro, ensureKokoro, getKokoroVoices, type KokoroVoice } from "./kokoro.js";

// ---------------------------------------------------------------------------
// Text-to-Speech (modular engines):
//   - "openai": OpenAI-compatible TTS cloud API (OpenAI + self-hosted: CosyVoice,
//               GPT-SoVITS, XTTS, F5-TTS, Bark, …)
//   - "kokoro": local Kokoro (onnx + kokoro-js) — see engines/kokoro.ts
// Both are independent engine implementations; neither depends on echogarden.
// ---------------------------------------------------------------------------
export async function synthesizeSpeech(
  text: string,
  opts: {
    engine: "openai" | "kokoro";
    voice?: string;
    language?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    kokoroModel?: string; // label only; kokoro.ts uses the local official model
    kokoroVoice?: string;
    maleVoice?: string;
    femaleVoice?: string;
    /** When true, write to the library's tts folder and return the path.
     *  When false (default for Read-aloud), return the audio inline as a
     *  data URL so nothing is persisted to disk. */
    save?: boolean;
  }
): Promise<{ url?: string; dataUrl?: string }> {
  // Voice resolution.
  // Kokoro: the user configures male/female voice selects (the real UI
  // mechanism), so those MUST win. The generic `voice` field is a language
  // label ("en") and must never be used as a Kokoro voice name — doing so
  // makes findVoice() fall back to the first candidate (Heart) and ignore the
  // selection. kokoroVoice is only a single-voice fallback when no male/female
  // is set.
  // OpenAI-compatible: named voices (alloy/onyx/…) live in `voice`, or
  // male/female as a fallback.
  const pickVoice = (): string | undefined => {
    if (opts.engine === "kokoro") {
      const cands = [opts.maleVoice, opts.femaleVoice].filter(Boolean) as string[];
      if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
      if (opts.kokoroVoice) return opts.kokoroVoice;
      return undefined;
    }
    if (opts.voice) return opts.voice;
    const cands = [opts.maleVoice, opts.femaleVoice].filter(Boolean) as string[];
    return cands.length ? cands[Math.floor(Math.random() * cands.length)] : undefined;
  };

  // OpenAI-compatible returns MP3; local Kokoro returns WAV.
  const ext = opts.engine === "openai" ? "mp3" : "wav";
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

  if (opts.engine === "kokoro") {
    // Local Kokoro (neural, onnx) — standalone, no echogarden.
    // synthesizeKokoro returns a ready 16-bit PCM WAV Buffer.
    const wav = await synthesizeKokoro(text, {
      voice: pickVoice() || opts.kokoroVoice,
      language: opts.language || "en",
      model: opts.kokoroModel || "82m-v1.0-quantized",
    });
    return finish(wav);
  }

  throw new Error(`Unknown TTS engine: ${opts.engine}. Supported: kokoro, openai.`);
}

// --- Kokoro (neural TTS, fully local) ---
export { ensureKokoro, getKokoroVoices, type KokoroVoice };
