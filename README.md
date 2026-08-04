# Lingo

> **Local-first language-learning tool.** Offline speech-to-text, text-to-speech, and dictionary by default; optional LLM for deeper explanation, grammar, and chat.

Lingo is a lightweight, self-hosted study companion. You drop in audio/video/text, and it helps you learn: transcribe speech, read with sentence-level audio, look up words offline, and talk to an AI tutor. Everything that can run locally does — only the optional LLM features need an external endpoint.

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

### Dictionary lexicons (not in the repo)
The 564 MB `data/models/Library` folder in the dev environment is the **MDict dictionary lexicons** (the offline word database) — *not* an ML model, and **intentionally excluded from the repo** as runtime user data. Without it, the right-panel Dictionary still works by falling back to the configured LLM. The app runs fine either way.

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
│   │   ├── index.ts   # server entry
│   │   ├── db.ts      # SQLite + library paths
│   │   └── engines.ts # STT / TTS / LLM + model download
│   ├── web/           # React front-end (pages + components)
│   ├── shared/        # shared TypeScript types
│   └── electron/      # desktop shell (main.cjs)
├── docs/              # user manual (zh)
├── package.json
└── vite.config.ts
```

> **Not in the repo:** `node_modules/`, `.venv/`, `dist/`, `data/` (runtime word library + dictionary lexicons, ~566 MB), and `.DS_Store`. See `.gitignore`.

## 📄 License

See repository for license details.
