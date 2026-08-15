// Shared HTTP + error helpers for the engine modules (STT / TTS / LLM).
import { execFile } from "child_process";

/** Run curl — system proxy works automatically, no Node.js proxy hell.
 *  Returns raw stdout buffer + HTTP status code.
 *  IMPORTANT: uses encoding:"buffer" so binary bodies (MP3/WAV audio) are
 *  NOT corrupted by utf8 round-tripping. The HTTP status code is appended
 *  by curl after a trailing "\n" (-w), so we split at the LAST newline. */
export function curl(args: string[]): Promise<{ stdout: Buffer; code: number }> {
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

/** Turn echogarden's cryptic download errors into an actionable message. */
export function friendlyDownloadError(e: any): string {
  const msg = String(e?.message || e);
  if (/status code (40[0-9]|50[0-9])|ENOTFOUND|ECONNREFUSED|fetch failed|ETIMEDOUT|network|certificate/i.test(msg)) {
    return `Model download failed: cannot reach HuggingFace (huggingface.co). Check your internet connection — some networks or sandboxes block HF. (${msg})`;
  }
  return msg;
}
