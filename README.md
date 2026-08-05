# Lingutribe

> **Local-first language-learning tool.** Offline speech-to-text, text-to-speech, and dictionary by default; optional LLM for deeper explanation, grammar, and chat.

Lingutribe is a lightweight, self-hosted study companion. You drop in audio/video/text, and it helps you learn: transcribe speech, read with sentence-level audio, look up words offline, and talk to an AI tutor. Everything that can run locally does — only the optional LLM features need an external endpoint.

🇨🇳 **中文说明：[README.zh-CN.md](./README.zh-CN.md)** — 安装方式、模型手动下载链接与离线安装步骤见该文档。

## 🆕 What's new

- **Player UI overhaul** — Transcript and Statistics are now tabs beside Delete; audio gets a native-styled transport bar (dark track, green progress); the video layout shows captions below the player with a show/hide toggle.
- **Captions / subtitles** — Each line now shows a `MM:SS – MM:SS` time range (YouTube-style) instead of `#N`, renders at 13px, and scrolls without vertical jumping (fixed-height rows + contained smooth scroll, synced to the timeline).
- **Statistics redesign** — Each COCA band (`0–1000`, `1000–3000`, … `6000+`) shows as a centered heading with a divider; its words are listed directly — no click-to-expand.
- **Stronger COCA lemmatizer** — Contractions (`I'm`, `it'll`, `don't`, `gonna`…) now map into the 1K band; irregular inflections (`went→go`, `children→child`, `men→man`) and more suffix rules (plurals, `-ies/-ied→y`, `-es`) are handled.
- **Backend cleanup** — `analysis`, `segments`, and `ffmpeg` helpers extracted out of the Express entry into dedicated modules for easier maintenance.
- **Comfortable layout** — Transcript / Statistics content keeps clear margins from the sidebar with more vertical breathing room.

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
│   │   ├── index.ts      # server entry
│   │   ├── db.ts         # SQLite + library paths
│   │   ├── engines.ts    # STT / TTS / LLM + model download
│   │   ├── analysis.ts   # media analysis (duration, peaks, segments)
│   │   ├── segments.ts   # word/segment timing types & helpers
│   │   └── util-ffmpeg.ts# ffmpeg discovery/util
│   ├── web/           # React front-end (pages + components)
│   │   ├── components/ # PlayerView, Transcript, Caption, AudioBar, VocabProfile…
│   │   └── lib/       # coca.ts (frequency bands), segments.ts (timing)
│   ├── shared/        # shared TypeScript types
│   └── electron/      # desktop shell (main.cjs)
├── docs/              # user manual (zh)
├── package.json
└── vite.config.ts
```

> **Not in the repo:** `node_modules/`, `.venv/`, `dist/`, `data/` (runtime word library + dictionary lexicons, ~566 MB), and `.DS_Store`. See `.gitignore`.

## 📄 License

See repository for license details.
