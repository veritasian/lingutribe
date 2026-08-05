/**
 * Locate ffmpeg on this system (PATH or common macOS/Linux paths).
 * Returns the absolute path to the binary or null if not found.
 * Cached after first successful lookup — ffmpeg paths don't move during the
 * lifetime of a server.
 */
import { execFileSync } from "child_process";
import fs from "fs";

let cached: string | null | undefined;

export function findFfmpeg(): string | null {
  if (cached !== undefined) return cached;
  if (process.env.FFMPEG_BIN) {
    cached = process.env.FFMPEG_BIN;
    return cached;
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where", ["ffmpeg"], { windowsHide: true })
        .toString().trim();
      cached = out.split(/\r?\n/)[0] || null;
      return cached;
    } catch {
      cached = null;
      return cached;
    }
  }
  for (const c of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    try { fs.accessSync(c, fs.constants.X_OK); cached = c; return cached; } catch { /* next */ }
  }
  try {
    const out = execFileSync("which", ["ffmpeg"]).toString().trim();
    cached = out.split(/\r?\n/)[0] || null;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}
