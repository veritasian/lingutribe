import { recognize } from "echogarden";
import { curl, friendlyDownloadError } from "./http.js";

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
