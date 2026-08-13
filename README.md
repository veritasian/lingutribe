# Lingutribe Core (Engine)

> **Public, open-source backend.** Local-first speech-to-text, text-to-speech, offline dictionary, and an optional LLM proxy — served over a REST API.

This repository is the **engine** of Lingutribe. It contains **no UI**. The React
front-end lives in a separate **private** repository
([`veritasian/lingutribe-web`](https://github.com/veritasian/lingutribe-web)).
The two communicate **only over HTTP** (see [How the UI calls this engine](#how-the-ui-calls-this-engine-the-contract)).

---

## What this repo is / isn't

| This repo **IS** | This repo is **NOT** |
|------------------|----------------------|
| Express REST API (port **8787**) | The React UI (`lingutribe-web`) |
| STT (Whisper via echogarden) | `vite.config.ts` / Tailwind / the SPA build |
| Local TTS (Kokoro) + cloud TTS | The Electron desktop shell (`electron/` is in the web repo) |
| Offline MDict dictionary + LLM fallback | Any bundled `dist/` (the UI build) |
| Import pipeline (file / URL / RSS / Readability) | |
| SQLite storage (`better-sqlite3`) | |

---

## Repository layout (paths)

```
lingutribe/                       ← this repo (PUBLIC engine)
├── src/
│   ├── server/                   ← the entire backend
│   │   ├── index.ts              ← entry: boots Express, registers routes, listens on :8787
│   │   ├── db.ts                 ← SQLite + library paths
│   │   ├── engines/              ← per-engine modules
│   │   │   ├── stt.ts            ← Whisper transcription
│   │   │   ├── tts.ts            ← Kokoro / cloud TTS synthesis
│   │   │   ├── llm.ts            ← LLM chat / analyze proxy
│   │   │   ├── models.ts         ← model ensure/download orchestration
│   │   │   ├── http.ts           ← shared HTTP helpers
│   │   │   └── index.ts          ← engine registry
│   │   ├── routes/              ← thin HTTP layer (one file per resource)
│   │   │   ├── resources.ts      ├── words.ts        ├── notes.ts
│   │   │   ├── chat.ts           ├── dict.ts         ├── settings.ts
│   │   │   ├── import.ts         └── engines.ts
│   │   ├── analysis.ts           ← media analysis (duration, peaks, segments)
│   │   ├── segments.ts           ← word/segment timing types & helpers
│   │   └── util-ffmpeg.ts        ← ffmpeg discovery
│   └── shared/
│       └── types.ts             ← (legacy, unused) shared TS types — the UI carries its own
├── data/                        ← gitignored: coca-bands.json, models/ (echogarden cache), coca-build/
├── docs/                        ← user manual (zh)
├── package.json                 ← server-only deps + scripts (below)
└── tsconfig.json
```

> **Not here:** `src/web/`, `vite.config.ts`, `tailwind.config.js`, `electron/`,
> `dist/`, `dist-server/`, `node_modules/`, `data/` — those belong to the private
> web repo or are git-ignored build/runtime artifacts.

### Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev:server` | `tsx watch src/server/index.ts` — API on `:8787` with live reload |
| `npm start` | `tsx src/server/index.ts` — run once |
| `npm run build:server` | bundle to `dist-server/index.mjs` (ESM, native modules external) for packaging |
| `npm run typecheck` | `tsc --noEmit` |

---

## How the UI calls this engine (the contract)

The UI and this engine are **decoupled by an HTTP contract only**. There is **no
shared code import** between them.

```
┌────────────────────┐         fetch('/api/...')          ┌──────────────────────┐
│  lingutribe-web    │  ───────────────────────────────▶ │   lingutribe-core    │
│  (React UI, :5173) │   relative /api/*  (JSON)          │   Express API :8787  │
└────────────────────┘  ◀─────────────────────────────── └──────────────────────┘
                                                JSON response
```

1. **The engine listens on `http://localhost:8787`.**
2. **The UI issues relative requests**, e.g. `fetch('/api/resources')` from
   `src/web/api.ts` — never a hard-coded host. This keeps the same code working
   in dev, in production, and inside the packaged app.
3. **In development**, the UI runs on Vite (`:5173`). Its `vite.config.ts` proxies
   every `/api/*` request to `http://localhost:8787`:
   ```js
   // lingutribe-web/vite.config.ts
   server: { proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } } }
   ```
   So the browser only ever talks to `:5173`; Vite forwards the API calls.
4. **In production / packaged app**, the engine serves the built UI from `dist/`
   itself and answers `/api/*` on the **same origin and port (`:8787`)**. There is
   no proxy — single origin, single port.
5. **Type contract:** the UI defines its own TypeScript types in
   `src/web/api.ts` (mirroring the JSON shapes below). This repo's
   `src/shared/types.ts` is legacy and is **not imported** by either side. The
   "contract" is therefore the **URL + JSON shape**, not shared TypeScript.

### API surface (all under `/api`)

> Full list is in `src/server/routes/*`. Representative endpoints:

| Group | Method & path | Purpose |
|-------|--------------|---------|
| Health | `GET /api/health` | liveness check (used by Electron + proxy) |
| Settings | `GET /api/settings`, `PUT /api/settings`, `GET /api/disk` | persisted config + disk usage |
| Resources | `GET /api/resources`, `POST /api/resources` (upload), `GET /api/resources/:id`, `GET /api/resources/:id/file`, `PUT /api/resources/:id`, `DELETE /api/resources/:id` | media library CRUD |
| | `POST /api/resources/:id/transcribe`, `GET /api/resources/:id/analysis` | STT + media analysis |
| Words | `GET /api/words`, `POST /api/words`, `PUT /api/words/:id`, `DELETE /api/words/:id` | spaced-repetition word lists |
| Notes | `GET /api/notes`, `POST /api/notes`, `PUT /api/notes/:id`, `DELETE /api/notes/:id` | user notes |
| Chat | `GET /api/chat`, `POST /api/chat`, `DELETE /api/chat/:id` | AI tutor sessions |
| Dictionary | `GET /api/dict/list`, `GET /api/dict/lookup?word=`, `POST /api/dict/llm`, `GET /api/dict/audio` | offline MDict + LLM fallback |
| COCA | `GET /api/coca/bands` | frequency-band data |
| Engines | `POST /api/engines/stt/test`, `POST /api/engines/tts/test`, `POST /api/engines/llm/test` | engine self-tests |
| STT | `POST /api/stt/transcribe` (upload) | ad-hoc transcription |
| TTS | `POST /api/tts/synthesize`, `GET /api/tts/voices` | speech synthesis |
| LLM | `POST /api/llm/chat`, `POST /api/llm/analyze` | LLM chat / analysis |
| Models | `POST /api/models/ensure`, `POST /api/models/ensure-kokoro` | ensure models are cached |
| Import | `POST /api/import` (url/file), `POST /api/import/text` | import audio/video/text/URL |

---

## Quick start (engine only)

```bash
git clone https://github.com/veritasian/lingutribe.git
cd lingutribe
npm install

npm run dev:server     # API on http://localhost:8787 (live reload)
# or
npm start              # run once
npm run build:server   # bundle to dist-server/index.mjs (for packaging)
npm run typecheck
```

Then point any client at `http://localhost:8787/api/*` — the private UI
(`lingutribe-web`), or `curl`:

```bash
curl http://localhost:8787/api/health
# → {"ok":true}
```

---

## Relationship to the UI repo

| Repo | Visibility | Role |
|------|------------|------|
| `veritasian/lingutribe` (this repo) | **Public / open-source** | the engine API |
| `veritasian/lingutribe-web` | **Private** | the React UI + the sellable `.dmg` bundle |

The web repo consumes this engine in two ways:
- **Dev:** runs this engine on `:8787` and proxies `/api/*` to it (see above).
- **Packaged:** includes this engine as a `core/` git submodule and bundles
  `core/dist-server/index.mjs` into the `.dmg`; the engine serves the UI it
  builds.

---

## Do models install automatically?

**Short answer: the engine starts immediately after `npm install`, with zero
model downloads.** ML models download automatically the first time you use a
feature that needs them — then stay cached for fully offline use.

### What works with no download at all
The API, the database, Resources browsing, Words, Chat history, and Settings all
run after `npm install`.

### Speech / TTS models (auto-download on first use)
- **STT (Whisper)** and **local TTS (Kokoro)** are *not* downloaded during
  `npm install`.
- The first time you transcribe audio or generate local speech, echogarden
  fetches the model package from HuggingFace and caches it. After that, it works
  **offline**.
- You can also pre-deploy a model from **Settings → Engines → "Deploy"**:
  - Whisper: `tiny` (≈75 MB) … `large-v3-turbo`.
  - Kokoro: `82m-v1.0-quantized` (≈80 MB) or `82m-v1.0-fp32`.
- ⚠️ The **first** model download needs internet access to `huggingface.co`.

### Dictionary lexicons (optional, bring your own)
The Dictionary feature uses **offline MDict lexicons** (`.mdx`). The engine ships
with **none bundled** — dictionary files are user-supplied runtime data and are
excluded from the repo.
- **Where to put them:** drop your `.mdx` (plus `.mdd` if any) into the
  `dictionaries` folder inside your library path — default
  `~/Documents/LingoLibrary/dictionaries`, or `data/models/Library/dictionaries`
  in a local dev checkout.
- **No lexicon?** Any word not found locally falls back to the configured LLM.
- **Licensing note:** commercial dictionaries (Oxford / Longman / Collins /
  Merriam-Webster) are copyrighted and may **not** be redistributed. Use a
  lexicon you legally own, or a free/open one (e.g. Wiktionary-based MDict).

### Cloud engines (need your own key/endpoint)
Fish Audio TTS, OpenAI TTS, and OpenAI/Ollama LLM require your own API key or
endpoint URL in Settings. They download nothing locally but need network +
credentials. The LLM key is **user-supplied and stored only in the local
SQLite settings** — it is never in this source.

---

## Configuration

All engines are managed in **Settings → Engines** (persisted server-side). Each
engine type (STT / TTS / LLM) supports multiple named configs, reorderable by
drag-and-drop; the top one is the default.

- **STT:** local Whisper (auto-model) or disabled.
- **TTS:** local Kokoro (auto-model), Fish Audio, or OpenAI-compatible.
- **LLM:** Ollama (`http://localhost:11434`) or any OpenAI-compatible base URL +
  model + optional key.

Library data lives at `~/Documents/LingoLibrary` by default (word lists, notes,
TTS cache) and is created automatically.

## License

This engine is released under the repository's open-source license. The
companion UI (`lingutribe-web`) is proprietary and **not** included here.
