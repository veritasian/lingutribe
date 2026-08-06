# Lingutribe

> **Local-first language-learning tool.** Offline speech-to-text, text-to-speech, and dictionary by default; optional LLM for deeper explanation, grammar, and chat.

Lingutribe is a lightweight, self-hosted study companion. You drop in audio/video/text, and it helps you learn: transcribe speech, read with sentence-level audio, look up words offline, and talk to an AI tutor. Everything that can run locally does — only the optional LLM features need an external endpoint.

🇨🇳 **中文说明：[README.zh-CN.md](./README.zh-CN.md)** — 安装方式、模型手动下载链接与离线安装步骤见该文档。

## 🆕 What's new

- **Transcript dual view** — *Subtitle* (timestamped rows; click a word to look it up) and *Content* (readable prose; select text → **Ask AI / Copy** popup). Subtitle rows are fixed ~5–10s chunks with no overlapping lines; Content merges into ~25s paragraphs.
- **Cleaner STT output** — loop-repetition artifacts from Whisper/echogarden are collapsed automatically (server-side at transcribe time, and client-side for existing resources). If a resource already has subtitles (e.g. imported YouTube captions), re-transcription is skipped.
- **Saved prompts** — LLM prompts now keep a history in Settings → LLM; type `/` in the Ask dialog to insert a saved prompt (name + content).
- **Player header** — Transcript / Statistics / Transcribe / Delete are icon buttons grouped with a click-to-cycle speed control on the right; waveform toggle and panel close are icon-only with tooltips; the right panel width is draggable and remembered.
- **Sidebar & filters** — icon-style expand/collapse toggles with a consistent hover-circle; the COCA filter bar stays fixed while words scroll below it.
- **Smaller desktop app** — the unused `kuromoji` (Japanese segmentation) and Microsoft speech SDK are excluded from the packaged dmg (≈240 MB → ≈224 MB); the fully offline Whisper/Kokoro/Ollama stack is unchanged.
- **Captions / subtitles** — each line shows a `MM:SS – MM:SS` time range (YouTube-style) with fixed-height rows and contained smooth scroll synced to playback.
- **Stronger COCA lemmatizer** — contractions (`I'm`, `it'll`, `gonna`…) map into the 1K band; irregular inflections (`went→go`, `children→child`, `men→man`) and more suffix rules are handled.

---

## ✨ Features

- **Resources** — import local audio/video or a URL; auto-transcribe (Whisper), show a word-level waveform, split/join, speed control, and spacebar-to-play.
- **Read** — paste or open text; auto-saved per note; click any sentence to hear it read aloud (Kokoro, fully local).
- **Dictionary panel** — select a word and get an offline MDict definition + LLM fallback (grammar, ask-AI, word-form restoration).
- **Words** — COCA frequency-band coloring and filtering so you focus on the words that matter.
- **Chat** — multi-session AI tutor with persistent history.
- **Settings** — drag-to-reorder, multi-config STT / TTS / LLM engines (local-first, with cloud fallbacks).
- **Desktop** — optional Electron shell wraps the same server into a native app.

## 🧱 Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React + Vite + Tailwind + TypeScript |
| Backend | Express + `tsx` + better-sqlite3 |
| Speech-to-Text | echogarden (Whisper) — local |
| Text-to-Speech | Kokoro (local), Fish Audio / OpenAI (optional cloud) |
| Dictionary | MDict lexicons (offline) + LLM fallback |
| Desktop | Electron |
| Media fetch | `yt-dlp` / `curl` (system binaries) |

## 🚀 Quick Start

```bash
git clone https://github.com/veritasian/lingutribe.git
cd lingutribe
npm install

# Development (Web UI on :5173, API on :8787)
npm run dev

# Production (build once, then serve the bundled app on :8787)
npm run build
npm start

# Desktop app (Electron shell around the server)
npm run app
```

Open **http://localhost:5173** in development, or **http://localhost:8787** after `npm start`.

## 🏗 Architecture & ports

- **Development** — two processes, two ports: Vite dev server on **5173** (React + HMR) and the Express API on **8787**; Vite proxies `/api/*` to 8787.
- **Production** — one process, one port: Express serves the built SPA from `dist/` *and* the API on **8787** (`npm run build && npm start`).
- **Desktop app (dmg)** — the Electron main process `import()`s the pre-compiled server (`dist-server/index.mjs`) directly, so the API runs **inside the Electron main process** (single process; no separate server). It listens on **8787 only — 5173 is never used by the packaged app**. If something is already listening on 8787 (e.g. a dev server), the app reuses it instead of starting its own instance.

---

## 🤖 Do models install automatically?

**Short answer: the app starts immediately after `npm install`, with zero model downloads. ML models download automatically the first time you use a feature that needs them — then stay cached for fully offline use.**

### What works with no download at all
The UI, the database, Resources browsing, Read (text only), Words, Chat history, and Settings all run after `npm install`. **You can launch and use the app right away.**

### Speech / TTS models (auto-download on first use)
- **STT (Whisper)** and **local TTS (Kokoro)** are *not* downloaded during `npm install`.
- The first time you transcribe audio or generate local speech, echogarden fetches the model package from HuggingFace and caches it under its package cache. After that, it works **offline**.
- You can also pre-deploy a model from **Settings → Engines → "Deploy"**:
  - Whisper: choose `tiny` (≈75 MB) … `large` (`large-v3-turbo`, larger).
  - Kokoro: `82m-v1.0-quantized` (≈80 MB) or `82m-v1.0-fp32`.
- ⚠️ The **first** model download needs internet access to `huggingface.co`. Some networks/sandboxes block HuggingFace — if so, the app shows a friendly error instead of failing silently.

### Dictionary lexicons (optional, bring your own)
The right-panel Dictionary uses **offline MDict lexicons** (`.mdx` files). The app ships with **none bundled** — dictionary files are user-supplied runtime data and are excluded from the repo (see `.gitignore`).
- **Where to put them:** drop your `.mdx` (plus the companion `.mdd` if any) into the `dictionaries` folder inside your library path — default `~/Documents/LingoLibrary/dictionaries`, or `data/models/Library/dictionaries` in a local dev checkout. The app re-scans that folder on each lookup, so a newly added file is picked up without a restart.
- **No lexicon yet?** The Dictionary panel still works — any word not found locally falls back to the configured LLM (Settings → Engines → LLM). The app is fully usable with zero dictionary setup.
- **Licensing note:** high-quality commercial dictionaries (Oxford / Longman / Collins / Merriam-Webster) are copyrighted, so their `.mdx` conversions may **not** be redistributed. Use a lexicon you legally own, or a free/open one (e.g. a Wiktionary-based MDict build). The LLM fallback covers everything else.
- **Where to find lexicons:** a large community index of MDict `.mdx` files lives at `https://mdx.mdict.org/`. Only add dictionaries you are licensed to use.
- **What the 564 MB folder actually is:** `data/models/Library` in the dev environment is the **echogarden model cache** (Whisper + Kokoro), *not* dictionary data.

### Cloud engines (need your own key/endpoint)
Fish Audio TTS, OpenAI TTS, and any OpenAI/Ollama LLM require your own API key or endpoint URL in Settings. They download nothing locally but need network + credentials.

---

## ⚙️ Configuration

All engines are managed in **Settings → Engines**. Each engine type (STT / TTS / LLM) supports multiple named configs that you can reorder by drag-and-drop; the top one is used by default.

- **STT:** local Whisper (auto-model) or leave disabled.
- **TTS:** local Kokoro (auto-model), Fish Audio, or OpenAI-compatible.
- **LLM:** Ollama (`http://localhost:11434`) or any OpenAI-compatible base URL + model + optional key.

Library data lives at `~/Documents/LingoLibrary` by default (word lists, notes, TTS cache) and is created automatically.

## 📁 Project Structure

```
lingutribe/
├── src/
│   ├── server/        # Express API + better-sqlite3 + echogarden engines
│   │   ├── index.ts      # server entry (boot + resource/import routes)
│   │   ├── db.ts         # SQLite + library paths
│   │   ├── engines/      # per-engine modules: stt / tts / llm / models / http
│   │   ├── routes/       # thin HTTP layer: settings, words, notes, chat,
│   │   │                 # engines (STT/TTS/LLM endpoints), dict (MDict)
│   │   ├── analysis.ts   # media analysis (duration, peaks, segments)
│   │   ├── segments.ts   # word/segment timing types & helpers
│   │   └── util-ffmpeg.ts# ffmpeg discovery/util
│   ├── web/           # React front-end (pages + components)
│   │   ├── components/ # PlayerView, Transcript, Caption, AudioBar, VocabProfile…
│   │   └── lib/       # coca.ts (frequency bands), segments.ts (timing)
│   └── shared/        # shared TypeScript types
├── electron/          # desktop shell (main.cjs — embeds the server when packaged)
├── docs/              # user manual (zh)
├── package.json
└── vite.config.ts
```

> **Not in the repo:** `node_modules/`, `.venv/`, `dist/`, `dist-electron/`, `data/` (runtime word library + dictionary lexicons, ~566 MB), and `.DS_Store`. See `.gitignore`.

## 📄 License

See repository for license details.
