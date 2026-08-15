import { recognize, align } from "echogarden";
import { curl, friendlyDownloadError } from "./http.js";

// ---------------------------------------------------------------------------
// Speech-to-Text
//
// Single backend: echogarden / Whisper — broad language coverage, word timeline.
// (Moonshine was removed — see git history.) Auto-installs its model on first use.
// ---------------------------------------------------------------------------
export interface TranscribeResult {
  transcript: string;
  words?: { text: string; start: number; end: number }[];
}

export interface AlignResult {
  transcript: string;
  words?: { text: string; start: number; end: number }[];
}

/**
 * Forced alignment — given audio + a *known* transcript, produce precise
 * per-word timestamps. Uses echogarden's `dtw` engine: it synthesizes the
 * transcript with eSpeak and DTW-matches it against the original audio, so it
 * needs no large recognition model (only eSpeak, auto-downloaded on first use).
 *
 * This is more accurate than Whisper's free-form word timeline when the correct
 * text is already known (e.g. a pasted script, or a transcript that needs
 * tighter timing than recognition produced). It also powers "align my
 * transcript to this audio" for resources that have text but no word timings.
 *
 * `crop` is forced off so the returned timestamps map to the *original* audio
 * (matching the file the player loads), not a VAD-cropped copy.
 */
export async function alignFile(
  filePath: string,
  transcript: string,
  language = "en"
): Promise<AlignResult> {
  let result: any;
  try {
    result = await align(filePath, transcript, {
      language,
      crop: false,
      // dtw is the default engine; spelled as `dtw` at the options root
      // (not `alignment`). It synthesizes the transcript with eSpeak and
      // DTW-matches it to the audio — fast and fully offline.
      dtw: {} as any,
    });
  } catch (e) {
    throw new Error(friendlyDownloadError(e));
  }
  const words = (result.wordTimeline as any[] | undefined)?.map((w) => ({
    text: w.text,
    start: w.startTime ?? w.start,
    end: w.endTime ?? w.end,
  }));
  return { transcript: result.transcript || transcript, words };
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
  return transcribeWhisper(filePath, model, language);
}

// ---------------------------------------------------------------------------
// Backend — echogarden / Whisper
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
      // Disable echogarden's default VAD crop step: in 2.10.2 the whisper
      // engine instance lacks API.detectVoiceActivity, which crashes the whole
      // process. Cropping is only a pre-alignment optimization — transcription
      // and wordTimeline are unaffected by turning it off.
      crop: false,
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
