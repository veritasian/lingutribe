// Model download via echogarden's native package manager (guaranteed correct).
import { loadPackage } from "echogarden/dist/utilities/PackageManager.js";
import { friendlyDownloadError } from "./http.js";

/** Download an echogarden model package. Resolves when ready. */
export async function ensureModel(packageName: string): Promise<void> {
  try {
    await loadPackage(packageName);
  } catch (e) {
    throw new Error(friendlyDownloadError(e));
  }
}
