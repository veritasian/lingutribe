// Shared types between server and web client.

export type ResourceType = "audio" | "video" | "read";

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  filename: string;
  relativePath: string; // path under library root
  size: number;
  duration?: number; // seconds, for audio/video
  mimeType?: string;
  transcript?: string; // STT result
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Word {
  id: string;
  term: string;
  phonetics?: string;
  meaning?: string;
  example?: string;
  // simple spaced-repetition state
  level: number; // 0 = new, higher = better known
  reviewedAt?: number;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string; // markdown-ish plain text
  resourceId?: string; // optional link to a resource
  createdAt: number;
  updatedAt: number;
}

export type EngineKind = "stt" | "tts" | "llm";

export interface EngineSettings {
  stt: {
    engine: "echogarden"; // whisper via echogarden
    model: string; // e.g. "tiny", "base", "small"
  };
  tts: {
    engine: "kokoro" | "openai";
    voice?: string;
    // for openai-compatible endpoint
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  llm: {
    engine: "ollama" | "openai";
    baseUrl: string; // e.g. http://localhost:11434
    model: string; // e.g. qwen3:0.6b
    apiKey?: string;
  };
}

export interface AppSettings {
  libraryPath: string;
  engines: EngineSettings;
}

export interface DiskUsage {
  libraryPath: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  resourcesBytes: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  kind: EngineKind;
  // for echogarden: the package name it downloads
  packageName?: string;
  local: boolean; // already present on disk
}
