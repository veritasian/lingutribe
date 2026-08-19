// Engine routes — thin HTTP layer over the engine modules (engines/).
// Route parsing/validation only; actual work happens in engines/ + db.
import express from "express";
import {
  transcribeFile,
  synthesizeSpeech,
  chatWithLLM,
  chatWithLLMStream,
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
      const model = req.body.model || settings.engines.stt.model;
      const result = await transcribeFile(
        fp,
        model,
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
      // like "en" break kokoro). For other engines only an explicitly
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

  // 流式聊天：text/plain 增量返回（打字机效果）。
  // body.modelId 可选 —— 指定 llmHistory 中某条配置；缺省用默认模型。
  app.post("/api/llm/chat/stream", async (req, res) => {
    try {
      const settings = readSettings();
      const messages = (req.body.messages || []) as ChatMessage[];
      const modelId = req.body.modelId ? Number(req.body.modelId) : null;
      let cfg: any;
      if (modelId && Array.isArray(settings.llmHistory)) {
        const h = settings.llmHistory.find((x: any) => x.id === modelId);
        cfg = h
          ? {
              engine: h.engine ?? settings.engines?.llm?.engine,
              baseUrl: h.baseUrl ?? settings.engines?.llm?.baseUrl,
              model: h.model ?? settings.engines?.llm?.model,
              apiKey: h.apiKey ?? undefined,
            }
          : resolveLlm(settings);
      } else {
        cfg = resolveLlm(settings);
      }
      if (!cfg?.baseUrl || !cfg?.model) {
        return res
          .status(400)
          .json({ error: "未配置 LLM：请先在 设置 → LLM 中配置模型（Base URL / Model / Key）。" });
      }
      const stream = chatWithLLMStream(messages, cfg);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      const reader = stream.getReader();
      const encoder = new TextEncoder();
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(encoder.encode(value));
          }
        } catch (e: any) {
          try {
            res.write(encoder.encode(`\n[error] ${e?.message || "stream failed"}`));
          } catch {
            /* socket may be closed */
          }
        } finally {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      })();
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
      let engine: string = req.body.engine || "echogarden";
      if (engine !== "echogarden") {
        // Moonshine was removed; fall back to the only supported STT engine.
        engine = "echogarden";
      }
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

  // Available STT engines + their models — drives the UI picker.
  app.get("/api/engines/stt/options", (_req, res) => {
    res.json({
      engines: [
        {
          id: "echogarden",
          label: "Whisper (echogarden)",
          models: ["tiny", "base", "small", "medium", "large"],
        },
      ],
      defaultEngine: "echogarden",
    });
  });

  // Quick engine tests — try a real run and report success/failure.
  app.post("/api/engines/stt/test", async (req, res) => {
    try {
      const settings = readSettings();
      // Allow overriding with the on-screen selection (unsaved) like TTS does.
      let engine: string = req.body?.engine || settings.engines.stt.engine;
      const model: string = req.body?.model || settings.engines.stt.model;
      if (engine !== "echogarden") {
        // Moonshine was removed; fall back to the only supported STT engine.
        engine = "echogarden";
      }
      const pkg = sttPackageName(model);
      await ensureModel(pkg);
      res.json({ ok: true, model });
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
      // An empty reply is a real failure (e.g. Unsloth returning the answer in
      // reasoning_content) — don't report "ok" just because no error was thrown.
      if (!reply || !reply.trim()) {
        return res.status(500).json({
          error: `Model returned an empty response (content was blank). The endpoint is reachable and authenticated, but produced no text. Check the model/endpoint.`,
        });
      }
      res.json({ ok: true, engine: cfg.engine, model: cfg.model, preview: reply.slice(0, 80) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
