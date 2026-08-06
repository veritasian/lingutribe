// Engine routes — thin HTTP layer over the engine modules (engines/).
// Route parsing/validation only; actual work happens in engines/ + db.
import express from "express";
import {
  transcribeFile,
  synthesizeSpeech,
  chatWithLLM,
  ensureModel,
  ensureKokoro,
  getKokoroVoices,
  sttPackageName,
  type ChatMessage,
} from "../engines/index.js";

interface EngineCtx {
  readSettings: () => any;
  resolveLlm: (s: any) => any;
  resolveTts: (s: any) => any;
  buildTtsConfig: (h: any, live: any) => any;
  upload: any;
}

export function registerEngineRoutes(app: express.Express, ctx: EngineCtx) {
  const { readSettings, resolveLlm, resolveTts, buildTtsConfig, upload } = ctx;

  // --- STT / TTS / LLM endpoints ---
  app.post("/api/stt/transcribe", upload.single("file"), async (req, res) => {
    try {
      const fp = req.file!.path;
      const settings = readSettings();
      const result = await transcribeFile(
        fp,
        settings.engines.stt.model,
        req.body.language || "en"
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/tts/synthesize", async (req, res) => {
    try {
      const settings = readSettings();
      const resolved = resolveTts(settings);
      const tts: any = { ...resolved, ...req.body };
      // The generic settings "voice" field is openai-specific (legacy values
      // like "en" break kokoro/fish). For other engines only an explicitly
      // requested voice may win; otherwise male/female voices are picked inside
      // synthesizeSpeech.
      const baseEngine = resolved.engine;
      if (req.body.voice == null && baseEngine !== "openai") {
        tts.voice = undefined;
      }
      // Real-time by default; persist only when the user enables "save TTS audio".
      tts.save = req.body.save ?? !!settings.engines.tts.saveAudio;
      const out = await synthesizeSpeech(req.body.text || "", tts);
      res.json(out); // { url } when saved, { dataUrl } when real-time
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/llm/chat", async (req, res) => {
    try {
      const settings = readSettings();
      const messages = (req.body.messages || []) as ChatMessage[];
      const reply = await chatWithLLM(messages, resolveLlm(settings));
      res.json({ content: reply });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Sentence grammar / structure analysis (mirrors Enjoy analyze.command SYSTEM_PROMPT) ---
  const DEFAULT_GRAMMAR_PROMPT = `I speak {N}. You're my {L} coach. I'll provide {L} text, you'll help me analyze the sentence structure, grammar, and vocabulary/phrases, and provide a detailed explanation of the text. Please return the results in the following format (but in {N}):

### Sentence Structure
(Explain each element of the sentence)

### Grammar
(Explain the grammar of the sentence)

### Vocabulary/Phrases
(Explain the key vocabulary and phrases used)`;

  // Resolve a prompt: use the user's custom template if set, otherwise the
  // built-in default. Substitute {L}/{N} with the chosen languages.
  function promptFor(custom: string | undefined, fallback: string, L: string, N: string): string {
    const tpl = custom && custom.trim() ? custom : fallback;
    return tpl.replaceAll("{L}", L).replaceAll("{N}", N);
  }

  // (Word lookup is now served by the offline MDict engine above — no LLM.)

  // Sentence-level grammar / structure analysis
  app.post("/api/llm/analyze", async (req, res) => {
    try {
      const settings = readSettings();
      const text = (req.body.text || "").trim();
      if (!text) return res.status(400).json({ error: "text required" });
      const { learning, native } = settings.languages || { learning: "en", native: "zh" };
      const system = promptFor(settings.prompts?.grammar, DEFAULT_GRAMMAR_PROMPT, learning, native);
      const content = await chatWithLLM(
        [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        resolveLlm(settings)
      );
      res.json({ content });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/models/ensure", async (req, res) => {
    try {
      const pkg = sttPackageName(req.body.model || "tiny");
      await ensureModel(pkg);
      res.json({ ok: true, package: pkg });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/tts/voices", async (_req, res) => {
    try {
      res.json(await getKokoroVoices());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/models/ensure-kokoro", async (req, res) => {
    try {
      const model = req.body.model || "82m-v1.0-quantized";
      const pkgs = await ensureKokoro(model);
      res.json({ ok: true, packages: pkgs });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Quick engine tests — try a real run and report success/failure.
  app.post("/api/engines/stt/test", async (req, res) => {
    try {
      const settings = readSettings();
      const pkg = sttPackageName(settings.engines.stt.model);
      await ensureModel(pkg);
      res.json({ ok: true, model: settings.engines.stt.model });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/engines/tts/test", async (req, res) => {
    try {
      const settings = readSettings();
      // Test the on-screen form config when supplied, else the saved default.
      const live = settings.engines?.tts || {};
      const t = req.body?.config ? buildTtsConfig(req.body.config, live) : resolveTts(settings);
      // Test is always real-time (no file persisted) — pass save:false.
      await synthesizeSpeech("test", {
        engine: t.engine as any,
        voice: t.voice || undefined,
        baseUrl: t.baseUrl || undefined,
        apiKey: t.apiKey || undefined,
        model: t.model || undefined,
        kokoroModel: (t.kokoroModel || "82m-v1.0-quantized") as any,
        fishModel: t.fishModel || undefined,
        maleVoice: t.maleVoice || undefined,
        femaleVoice: t.femaleVoice || undefined,
        save: false,
      });
      res.json({ ok: true, engine: t.engine });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/engines/llm/test", async (req, res) => {
    try {
      const settings = readSettings();
      // Test the on-screen form config when supplied, else the saved default.
      const cfg = req.body?.config ? req.body.config : resolveLlm(settings);
      const reply = await chatWithLLM([{ role: "user", content: "hi" }], cfg);
      res.json({ ok: true, engine: cfg.engine, model: cfg.model, preview: reply.slice(0, 80) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
