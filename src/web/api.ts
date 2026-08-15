// Thin API client for the single-process Express backend.

async function req<T = any>(url: string, init?: RequestInit): Promise<T> {
  // Don't set Content-Type for FormData — the browser adds multipart boundary automatically.
  const headers: Record<string,string> = init?.body instanceof FormData
    ? { ...(init?.headers as any || {}) }
    : { "Content-Type": "application/json", ...(init?.headers as any || {}) };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const t = await res.text();
    // Prefer the structured { error } message over the raw HTML/JSON body.
    let msg = t || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(t);
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* not JSON — keep the raw body */
    }
    throw new Error(msg);
  }
  return res.json();
}

export interface WordHit {
  text: string;
  start: number;
  end: number;
}
export interface Resource {
  id: string;
  type: string;
  name: string;
  filename: string;
  relativePath: string;
  size: number;
  duration?: number;
  mimeType?: string;
  transcript?: string;
  words?: WordHit[] | string;
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
  level: number;
  reviewedAt?: number;
  createdAt: number;
}
export interface Note {
  id: string;
  title: string;
  body: string;
  resourceId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}
export interface Settings {
  libraryPath: string;
  languages: { learning: string; native: string };
  uiLang?: "en" | "zh";
  engines: {
    stt: { engine: string; model: string };
    tts: { engine: string; voice?: string; language?: string; baseUrl?: string; apiKey?: string; model?: string; kokoroVoice?: string; kokoroModel?: string; maleVoice?: string; femaleVoice?: string; saveAudio?: boolean };
    llm: { engine: string; baseUrl: string; model: string; apiKey?: string };
  };
  prompts?: { grammar: string; list?: SavedPrompt[] };
  llmHistory?: { id: number; ts: string; engine: string; baseUrl: string; model: string; apiKey?: string }[];
  sttHistory?: { id: number; ts: string; model: string }[];
  ttsHistory?: { id: number; ts: string; engine: string; voice: string; model?: string; maleVoice?: string; femaleVoice?: string; baseUrl?: string; apiKey?: string }[];
  defaultTtsId?: number;
  defaultLlmId?: number;
  // Which offline MDict dictionary to use for lookups. null => auto (first match).
  activeDictionary?: string | null;
}
export interface DiskUsage {
  libraryPath: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  resourcesBytes: number;
}

export interface KokoroVoice {
  name: string;
  languages: string[];
  gender: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

import type { Segment } from "./lib/segments";

/**
 * Cached analysis result for a resource. Returned by the server's
 * /api/resources/:id/analysis endpoint. The renderer uses this on open
 * to skip re-deriving subtitles, durations, and waveform peaks.
 */
export interface Analysis {
  version: number;
  resourceId: string;
  md5: string;
  createdAt: string;
  duration: number;
  durationProbedAt: number;
  transcript: string;
  words: WordHit[];
  segments: Segment[];
  peaks: number[];
  peaksPerSec: number;
}

export const api = {
  health: () => req("/api/health"),
  // settings
  getSettings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Settings) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  getDisk: () => req<DiskUsage>("/api/disk"),
  // resources
  listResources: () => req<Resource[]>("/api/resources"),
  uploadResource: async (file: File, type: string, name?: string, duration?: number) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", type);
    if (name) fd.append("name", name);
    if (duration) fd.append("duration", String(duration));
    const res = await fetch("/api/resources", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  getResource: (id: string) => req<Resource>(`/api/resources/${id}`),
  deleteResource: (id: string) => req(`/api/resources/${id}`, { method: "DELETE" }),
  updateResource: (id: string, data: { transcript?: string; words?: string; note?: string }) =>
    req(`/api/resources/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  saveResource: (id: string, patch: Partial<Resource>) =>
    req(`/api/resources/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  transcribeResource: (id: string, language?: string) =>
    req(`/api/resources/${id}/transcribe`, { method: "POST", body: JSON.stringify({ language }) }),
  // Forced alignment: align the resource audio to a known transcript to get
  // precise per-word timestamps. `transcript` is optional — when omitted the
  // server uses the resource's stored transcript.
  alignResource: (id: string, transcript?: string, language?: string) =>
    req<{ transcript: string; words: WordHit[]; aligned: boolean; method: string }>(
      `/api/resources/${id}/align`,
      { method: "POST", body: JSON.stringify({ transcript: transcript || undefined, language: language || undefined }) }
    ),
  /** Pre-computed analysis cache: peaks, segments, transcript, duration.
   *  Returns null when the server has no cache yet (e.g. never transcribed). */
  getAnalysis: async (id: string) => {
    try {
      return await req<Analysis>(`/api/resources/${id}/analysis`);
    } catch {
      return null;
    }
  },
  // Import a resource from a URL (video link / podcast link). Pulls media +
  // subtitles when available; returns the resource row with words populated.
  importUrl: (url: string, type: string) =>
    req<Resource & { words?: WordHit[] }>("/api/import", {
      method: "POST",
      body: JSON.stringify({ url, type }),
    }),
  importText: (payload: { file?: File; url?: string; name?: string }) => {
    const fd = new FormData();
    if (payload.file) fd.append("file", payload.file);
    if (payload.url) fd.append("url", payload.url);
    if (payload.name) fd.append("name", payload.name);
    return req<Resource>("/api/import/text", { method: "POST", body: fd });
  },
  // Offline dictionary lookup via the MDict engine (no LLM).
  // `dict` optionally restricts the lookup to a specific installed dictionary.
  dictLookup: (word: string, dict?: string | null) =>
    req<{
      word: string;
      found: boolean;
      html: string | null;
      text: string | null;
      dictTitle: string | null;
      message?: string;
    }>(
      `/api/dict/lookup?word=${encodeURIComponent(word)}${
        dict ? "&dict=" + encodeURIComponent(dict) : ""
      }`
    ),
  analyze: (text: string) =>
    req<{ content: string }>("/api/llm/analyze", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  // LLM fallback dictionary definition for words with no local MDict entry.
  dictLlm: (word: string) =>
    req<{ content: string }>("/api/dict/llm", {
      method: "POST",
      body: JSON.stringify({ word }),
    }),
  // Ask-AI chat history (persisted per thread).
  chatHistory: (thread: string) =>
    req<{ messages: { id: string; role: string; content: string; createdAt: number }[] }>(
      `/api/chat?thread=${encodeURIComponent(thread)}`
    ),
  saveChatMessage: (thread: string, role: string, content: string) =>
    req<{ id: string; role: string; content: string; createdAt: number }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ thread, role, content }),
    }),
  deleteChatMessage: (id: string) => req(`/api/chat/${id}`, { method: "DELETE" }),
  // words
  listWords: () => req<Word[]>("/api/words"),
  createWord: (w: Partial<Word>) => req<Word>("/api/words", { method: "POST", body: JSON.stringify(w) }),
  updateWord: (id: string, w: Partial<Word>) => req(`/api/words/${id}`, { method: "PUT", body: JSON.stringify(w) }),
  deleteWord: (id: string) => req(`/api/words/${id}`, { method: "DELETE" }),
  // notes
  listNotes: (resourceId?: string) =>
    req<Note[]>(resourceId ? `/api/notes?resourceId=${encodeURIComponent(resourceId)}` : "/api/notes"),
  createNote: (n: Partial<Note>) => req<Note>("/api/notes", { method: "POST", body: JSON.stringify(n) }),
  updateNote: (id: string, n: Partial<Note>) => req(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify(n) }),
  deleteNote: (id: string) => req(`/api/notes/${id}`, { method: "DELETE" }),
  // engines
  transcribe: async (file: File, language?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (language) fd.append("language", language);
    const res = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  synthesize: (text: string, opts?: any) =>
    req<{ url?: string; dataUrl?: string }>("/api/tts/synthesize", { method: "POST", body: JSON.stringify({ text, ...opts }) }),
  chat: (messages: any[]) =>
    req<{ content: string }>("/api/llm/chat", { method: "POST", body: JSON.stringify({ messages }) }),
  ensureModel: (model: string, engine?: string) =>
    req("/api/models/ensure", { method: "POST", body: JSON.stringify({ model, engine }) }),
  sttOptions: () => req<{ engines: { id: string; label: string; models: string[] }[]; defaultEngine: string }>("/api/engines/stt/options"),
  ensureKokoro: (model: string) =>
    req("/api/models/ensure-kokoro", { method: "POST", body: JSON.stringify({ model }) }),
  testStt: (engine?: string, model?: string) =>
    req<{ ok: boolean; model?: string; engine?: string }>("/api/engines/stt/test", {
      method: "POST",
      body: JSON.stringify(engine || model ? { engine, model } : {}),
    }),
  // Optionally pass the on-screen config so the Test button verifies exactly
  // the engine/URL/key/model the user is currently editing.
  testTts: (cfg?: any) =>
    req<{ ok: boolean; engine: string }>("/api/engines/tts/test", {
      method: "POST",
      body: JSON.stringify(cfg ? { config: cfg } : {}),
    }),
  testLlm: (cfg?: any) =>
    req<{ ok: boolean; model: string; preview: string }>("/api/engines/llm/test", {
      method: "POST",
      body: JSON.stringify(cfg ? { config: cfg } : {}),
    }),
  getKokoroVoices: () => req<KokoroVoice[]>("/api/tts/voices"),
  // COCA frequency bands readiness + word-membership test.
  cocaTest: (word?: string) =>
    req<{
      ok: boolean;
      words?: number;
      path?: string;
      source?: string;
      word?: string;
      found?: boolean;
      rank?: number | null;
      band?: string | null;
      error?: string;
    }>("/api/coca/test" + (word ? `?word=${encodeURIComponent(word)}` : "")),
  // Offline dictionary install-status test.
  dictStatus: () =>
    req<{ ok: boolean; dir: string; count: number; titles: string[]; error?: string }>(
      "/api/dict/test"
    ),
  // Reveal a folder in the OS file manager (desktop app).
  revealFolder: (dir: string) =>
    req<{ ok: boolean; dir: string; method: string; error?: string }>("/api/system/reveal", {
      method: "POST",
      body: JSON.stringify({ dir }),
    }),
};

export const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
