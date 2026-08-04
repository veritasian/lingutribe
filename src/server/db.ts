import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

// --- Library path (configurable, defaults to ~/Documents/LingoLibrary) ---
const DEFAULT_LIBRARY = path.join(os.homedir(), "Documents", "LingoLibrary");

let libraryPath = DEFAULT_LIBRARY;
let db: Database.Database | null = null;

export function getLibraryPath(): string {
  return libraryPath;
}

export function setLibraryPath(p: string): void {
  libraryPath = p;
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.mkdirSync(path.join(libraryPath, "resources"), { recursive: true });
  // re-open db at new location
  if (db) db.close();
  db = null;
  getDb();
}

export function resourcesDir(): string {
  const d = path.join(libraryPath, "resources");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Per-type import folder: audio / video / read.
 *  Imported media is written into the matching subfolder under the library. */
export function typeDir(type: string): string {
  const sub = type === "read" ? "read" : type; // "audio" | "video" | "read"
  const d = path.join(libraryPath, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Dedicated folder for saved TTS audio (only used when the user opts in). */
export function ttsDir(): string {
  const d = path.join(libraryPath, "tts");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Resolve a stored relativePath (may include a type subfolder) to an
 *  absolute file path inside the library root. */
export function resourcePath(relativePath: string): string {
  return path.join(libraryPath, relativePath);
}

/** Resolve a stored relativePath to an existing file on disk.
 *  Supports both layouts:
 *   - new: relativePath includes the type subfolder (e.g. "audio/xxx.mp4")
 *          -> resolved as libraryPath/relativePath
 *   - legacy: flat filename (e.g. "xxx.mp4") living directly under
 *          resources/ (pre-restructure imports) -> resourcesDir()/relativePath
 *  Returns the absolute path, or "" if no file is found. */
export function resolveResourceFile(relativePath: string): string {
  if (!relativePath) return "";
  const primary = path.join(libraryPath, relativePath);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(resourcesDir(), relativePath);
  if (fs.existsSync(legacy)) return legacy;
  return "";
}

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(libraryPath, { recursive: true });
  const dbPath = path.join(libraryPath, "lingo.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration REAL,
      mimeType TEXT,
      transcript TEXT,
      words TEXT,
      note TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      phonetics TEXT,
      meaning TEXT,
      example TEXT,
      level INTEGER NOT NULL DEFAULT 0,
      reviewedAt INTEGER,
      createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      resourceId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread, createdAt);
  `);

  // Backfill: add the words column to databases created before this migration.
  const resCols = (d.pragma('table_info(resources)') as any[]).map((c: any) => c.name);
  if (!resCols.includes('words')) d.exec('ALTER TABLE resources ADD COLUMN words TEXT');
}

// --- generic helpers ---
export function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
