import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings, type DiskUsage, type KokoroVoice, fmtBytes } from "../api";
import { applyTheme } from "../App";
import { IconSettings, IconMic, IconVolume, IconRobot } from "../components/Icon";
import { switchLang } from "../lib/locale";

const STT_MODELS = ["tiny", "base", "small", "medium", "large"];

type Cat = "system" | "stt" | "tts" | "llm";

const CATS: { id: Cat; label: string; icon: ReactNode }[] = [
  { id: "system", label: "System", icon: <IconSettings size={18} /> },
  { id: "stt", label: "STT", icon: <IconMic size={18} /> },
  { id: "tts", label: "TTS", icon: <IconVolume size={18} /> },
  { id: "llm", label: "LLM", icon: <IconRobot size={18} /> },
];

// Mirror of the server DEFAULT_GRAMMAR_PROMPT — used for placeholder + live
// preview. Keep in sync with src/server/index.ts. (Word lookup now uses the
// offline MDict engine, so there is no "words" prompt to edit here.)
const DEFAULT_GRAMMAR_PROMPT = `I speak {N}. You're my {L} coach. I'll provide {L} text, you'll help me analyze the sentence structure, grammar, and vocabulary/phrases, and provide a detailed explanation of the text. Please return the results in the following format (but in {N}):

### Sentence Structure
(Explain each element of the sentence)

### Grammar
(Explain the grammar of the sentence)

### Vocabulary/Phrases
(Explain the key vocabulary and phrases used)`;

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [cat, setCat] = useState<Cat>("system");
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const [kokoroVoices, setKokoroVoices] = useState<KokoroVoice[]>([]);
  const [kokoroDeploying, setKokoroDeploying] = useState(false);
  const [kokoroMsg, setKokoroMsg] = useState("");
  const [sttTesting, setSttTesting] = useState(false);
  const [sttTestOk, setSttTestOk] = useState<boolean | null>(null);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestOk, setTtsTestOk] = useState<boolean | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestOk, setLlmTestOk] = useState<boolean | null>(null);
  const [savedCat, setSavedCat] = useState<Cat | null>(null);
  const [grammarSaved, setGrammarSaved] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("lingo-theme") || "light");

  // Drag-to-reorder state for the saved LLM / TTS config lists.
  // The item at index 0 is always the default (no star toggle needed).
  const [dragLlmIdx, setDragLlmIdx] = useState<number | null>(null);
  const [overLlmIdx, setOverLlmIdx] = useState<number | null>(null);
  const [dragTtsIdx, setDragTtsIdx] = useState<number | null>(null);
  const [overTtsIdx, setOverTtsIdx] = useState<number | null>(null);

  function setThemeMode(t: string) {
    setTheme(t);
    localStorage.setItem("lingo-theme", t);
    applyTheme(t);
    window.dispatchEvent(new Event("lingo-theme-change"));
  }

  async function load() {
    setSettings(await api.getSettings());
    setDisk(await api.getDisk());
  }
  useEffect(() => {
    load();
  }, []);

  // Lazily load the Kokoro voice list only when that engine is selected.
  useEffect(() => {
    if (settings?.engines.tts.engine === "kokoro" && kokoroVoices.length === 0) {
      api.getKokoroVoices().then(setKokoroVoices).catch(() => {});
    }
  }, [settings, kokoroVoices.length]);

  // When engine changes, clear maleVoice/femaleVoice so stale values from
  // another engine don't linger (e.g. Fish Audio reference_id in Kokoro).
  useEffect(() => {
    if (!settings) return;
    const engine = settings.engines.tts.engine;
    const mv = settings.engines.tts.maleVoice || "";
    const fv = settings.engines.tts.femaleVoice || "";
    // Heuristic: if the value looks like a Fish Audio reference_id (hex string
    // >= 20 chars) and we're not on fish engine, clear it.  Also clear if it
    // looks like an OpenAI voice name ("alloy","nova") on kokoro.
    const isRefId = (v: string) => /^[a-f0-9]{20,}$/i.test(v);
    const isOpenAiVoice = (v: string) => /^(alloy|echo|fable|onyx|nova|shimmer)$/i.test(v);
    let shouldClearM = false, shouldClearF = false;
    if (engine === "kokoro" && (isRefId(mv) || isOpenAiVoice(mv))) shouldClearM = true;
    if (engine === "kokoro" && (isRefId(fv) || isOpenAiVoice(fv))) shouldClearF = true;
    if (engine === "fish" && !isRefId(mv) && mv.length > 0 && !/^[a-f0-9]+$/i.test(mv)) shouldClearM = true;
    if (engine === "fish" && !isRefId(fv) && fv.length > 0 && !/^[a-f0-9]+$/i.test(fv)) shouldClearF = true;
    if (shouldClearM || shouldClearF) {
      const patch: any = {};
      if (shouldClearM) patch.maleVoice = "";
      if (shouldClearF) patch.femaleVoice = "";
      patchSettings({ engines: { ...settings.engines, tts: { ...settings.engines.tts, ...patch } } });
    }
  }, [settings?.engines.tts.engine]);

  function patchSettings(p: Partial<Settings>) {
    setSettings((s) => ({ ...(s as Settings), ...p }));
  }

  async function save(c?: Cat) {
    if (!settings) return;
    await api.saveSettings(settings);
    setSavedCat(c ?? cat);
    setTimeout(() => setSavedCat(null), 1500);
    await load();
  }

  // LLM "Confirm": persist the whole settings (engine + prompts) and append a
  // history record so saved configurations survive a reload.
  async function confirmLlm() {
    if (!settings) return;
    const llm = settings.engines.llm;
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      engine: llm.engine,
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKey: llm.apiKey || "",
    };
    const history = [entry, ...(settings.llmHistory || [])].slice(0, 50);
    // Newest config is prepended → it becomes the default (first = default).
    const next: Settings = { ...settings, llmHistory: history, defaultLlmId: entry.id };
    setSettings(next);
    await api.saveSettings(next);
    setSavedCat("llm");
    setTimeout(() => setSavedCat(null), 1500);
  }

  async function deploy() {
    if (!settings) return;
    setDeploying(true);
    setDeployMsg("⏳ Downloading Whisper model…");
    try {
      await api.ensureModel(settings.engines.stt.model);
      setDeployMsg("✅ Whisper ready – offline STT available");
    } catch (e: any) {
      setDeployMsg(`❌ ${e.message}`);
    } finally {
      setDeploying(false);
    }
  }

  async function deployKokoro() {
    if (!settings) return;
    setKokoroDeploying(true);
    setKokoroMsg("⏳ Downloading model (~80MB)…");
    try {
      await api.ensureKokoro(settings.engines.tts.kokoroModel || "82m-v1.0-quantized");
      setKokoroMsg("✅ Kokoro ready – offline TTS available");
      // Deploying locally implies the user wants Kokoro as the active engine.
      // Register it as the default TTS entry so the Test button (and real
      // synthesis) actually exercise Kokoro instead of the legacy Fish config.
      const tts = settings.engines.tts;
      const entry = {
        id: Date.now(),
        ts: new Date().toISOString(),
        engine: "kokoro",
        voice: tts.kokoroVoice || "",
        model: tts.kokoroModel || "82m-v1.0-quantized",
        maleVoice: tts.maleVoice || undefined,
        femaleVoice: tts.femaleVoice || undefined,
      };
      const history = [entry, ...(settings.ttsHistory || []).filter((h) => h.engine !== "kokoro")].slice(0, 20);
      const next = { ...settings, ttsHistory: history, defaultTtsId: entry.id };
      setSettings(next);
      await api.saveSettings(next);
    } catch (e: any) {
      setKokoroMsg(`❌ ${e.message}`);
    } finally {
      setKokoroDeploying(false);
    }
  }

  // STT: save + record history
  async function saveStt() {
    if (!settings) return;
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      model: settings.engines.stt.model,
    };
    const history = [entry, ...(settings.sttHistory || [])].slice(0, 20);
    const next: Settings = { ...settings, sttHistory: history };
    setSettings(next);
    await api.saveSettings(next);
    setSavedCat("stt");
    setTimeout(() => setSavedCat(null), 2000);
  }

  // TTS: save + record history
  async function saveTts() {
    if (!settings) return;
    const tts = settings.engines.tts;
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      engine: tts.engine,
      // Record the actual voices — never fall back to the engine name.
      voice: tts.kokoroVoice || tts.voice || tts.maleVoice || tts.femaleVoice || "",
      // Record the model that belongs to the CURRENT engine only.
      model:
        (tts.engine === "kokoro" ? tts.kokoroModel
          : tts.engine === "fish" ? tts.fishModel
          : tts.model) || undefined,
      maleVoice: tts.maleVoice || undefined,
      femaleVoice: tts.femaleVoice || undefined,
      // Persist URL + key so this config is fully self-contained.
      baseUrl: tts.baseUrl || undefined,
      apiKey: tts.apiKey || "",
    };
    const history = [entry, ...(settings.ttsHistory || [])].slice(0, 20);
    // Newest config is prepended → it becomes the default (first = default).
    const next: Settings = { ...settings, ttsHistory: history, defaultTtsId: entry.id };
    setSettings(next);
    await api.saveSettings(next);
    setSavedCat("tts");
    setTimeout(() => setSavedCat(null), 2000);
  }

  // Test STT engine
  async function testStt() {
    setSttTesting(true);
    setSttTestOk(null);
    try {
      await api.testStt();
      setSttTestOk(true);
    } catch {
      setSttTestOk(false);
    } finally {
      setSttTesting(false);
    }
  }

  // Test TTS engine
  async function testTts() {
    if (!settings) return;
    setTtsTesting(true);
    setTtsTestOk(null);
    try {
      // Test the config currently shown in the form (what the user sees).
      await api.testTts(e.tts);
      setTtsTestOk(true);
    } catch {
      setTtsTestOk(false);
    } finally {
      setTtsTesting(false);
    }
  }

  async function testLlm() {
    if (!settings) return;
    setLlmTesting(true);
    setLlmTestOk(null);
    try {
      // Test the config currently shown in the form (what the user sees),
      // not the saved default — so "what you see is what is tested".
      await api.testLlm(e.llm);
      setLlmTestOk(true);
    } catch {
      setLlmTestOk(false);
    } finally {
      setLlmTesting(false);
    }
  }

  function deleteSttHistory(id: number) {
    if (!settings) return;
    const next = { ...settings, sttHistory: (settings.sttHistory || []).filter((h) => h.id !== id) };
    setSettings(next);
    api.saveSettings(next);
  }
  function deleteTtsHistory(id: number) {
    if (!settings) return;
    const arr = (settings.ttsHistory || []).filter((h) => h.id !== id);
    // The first item is always the default; reassign after removal.
    const next = { ...settings, ttsHistory: arr, defaultTtsId: arr[0]?.id };
    setSettings(next);
    api.saveSettings(next);
  }
  function deleteLlmHistory(id: number) {
    if (!settings) return;
    const arr = (settings.llmHistory || []).filter((h) => h.id !== id);
    const next = { ...settings, llmHistory: arr, defaultLlmId: arr[0]?.id };
    setSettings(next);
    api.saveSettings(next);
  }

  // Reorder a saved-config list by drag-and-drop. After a move, the item now
  // at index 0 becomes the default automatically.
  function reorderLlm(from: number, to: number) {
    if (!settings) return;
    const arr = [...(settings.llmHistory || [])];
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const next: Settings = { ...settings, llmHistory: arr, defaultLlmId: arr[0]?.id };
    setSettings(next);
    api.saveSettings(next);
  }
  function reorderTts(from: number, to: number) {
    if (!settings) return;
    const arr = [...(settings.ttsHistory || [])];
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const next: Settings = { ...settings, ttsHistory: arr, defaultTtsId: arr[0]?.id };
    setSettings(next);
    api.saveSettings(next);
  }

  if (!settings) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const e = settings.engines;
  const prompts = settings.prompts ?? { grammar: "" };
  const history = settings.llmHistory ?? [];
  const L = settings.languages.learning;
  const N = settings.languages.native;
  const effGrammar = (prompts.grammar.trim() ? prompts.grammar : DEFAULT_GRAMMAR_PROMPT)
    .replaceAll("{L}", L)
    .replaceAll("{N}", N);

  return (
    <div className="flex h-full">
      {/* Left category rail */}
      <div className="w-[180px] border-r shrink-0 p-3 space-y-1">
        <div className="px-2 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          Settings
        </div>
        {CATS.map((c) => (
          <button
            key={c.id}
            className={`sidebar-item w-full ${cat === c.id ? "active" : ""}`}
            onClick={() => setCat(c.id)}
          >
            <span>{c.icon}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>

      {/* Right content */}
      <div className="scroll flex-1 min-w-0">
        <div className="max-w-2xl p-6 space-y-6">
          {/* ---------------- System ---------------- */}
          {cat === "system" && (
            <>
              <section className="note-card p-4 space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">Appearance</h2>
                <select
                  className="select"
                  value={theme}
                  onChange={(v) => setThemeMode(v.target.value)}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Light is the default Apple-style look; “System” follows your OS appearance.
                </p>
              </section>

              <section className="note-card p-4 space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground">Languages</h2>
                <div className="flex gap-3">
                  <label className="flex-1">
                    <span className="text-xs text-muted-foreground">UI language</span>
                    <select
                      className="select"
                      value={localStorage.getItem("lingo-ui-lang") === "zh" ? "zh" : "en"}
                      onChange={(v) => switchLang(v.target.value as "en" | "zh")}
                    >
                      <option value="en">English</option>
                      <option value="zh">中文</option>
                    </select>
                  </label>
                  <label className="flex-1">
                    <span className="text-xs text-muted-foreground">Learning language</span>
                    <input
                      className="input"
                      placeholder="en"
                      value={settings.languages.learning}
                      onChange={(v) =>
                        patchSettings({
                          languages: { ...settings.languages, learning: v.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="flex-1">
                    <span className="text-xs text-muted-foreground">Native language</span>
                    <input
                      className="input"
                      placeholder="zh"
                      value={settings.languages.native}
                      onChange={(v) =>
                        patchSettings({
                          languages: { ...settings.languages, native: v.target.value },
                        })
                      }
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Used by the word dictionary &amp; sentence-grammar prompts when you click a word.
                </p>
              </section>

              <section className="note-card p-4 space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground">Storage</h2>
                <label className="block">
                  <span className="text-xs text-muted-foreground">Library path</span>
                  <input
                    className="input"
                    value={settings.libraryPath}
                    onChange={(v) => patchSettings({ libraryPath: v.target.value })}
                  />
                </label>
                {disk && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Disk used</span>
                      <span>
                        {fmtBytes(disk.usedBytes)} / {fmtBytes(disk.totalBytes)}
                      </span>
                    </div>
                    <div className="progress">
                      <div
                        style={{
                          width: `${Math.min(100, (disk.usedBytes / disk.totalBytes) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Resources: {fmtBytes(disk.resourcesBytes)} · Free: {fmtBytes(disk.freeBytes)}
                    </div>
                  </div>
                )}
              </section>

              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={() => save("system")}>
                  Save
                </button>
                {savedCat === "system" && (
                  <span className="text-xs text-primary self-center">Saved ✓</span>
                )}
              </div>
            </>
          )}

          {/* ---------------- STT ---------------- */}
          {cat === "stt" && (
            <section className="note-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">Speech-to-Text</h2>
              <div className="flex items-end gap-3">
                <label className="flex-1">
                  <span className="text-xs text-muted-foreground">Whisper model</span>
                  <select
                    className="select"
                    value={e.stt.model}
                    onChange={(v) =>
                      patchSettings({ engines: { ...e, stt: { ...e.stt, model: v.target.value } } })
                    }
                  >
                    {STT_MODELS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <button className="btn btn-secondary" disabled={deploying} onClick={deploy}>
                  {deploying ? "⏳ Deploying…" : "Deploy locally"}
                </button>
              </div>
              {deployMsg && <div className="text-xs text-muted-foreground">{deployMsg}</div>}
              <div className="flex items-center gap-2">
                <button className="btn btn-primary" onClick={saveStt}>Save</button>
                <button className="btn btn-secondary" disabled={sttTesting} onClick={testStt}>
                  {sttTesting ? "Testing…" : "Test"}
                </button>
                {sttTestOk === true && <span className="text-xs text-green-500 font-medium">✓ Working</span>}
                {sttTestOk === false && <span className="text-xs text-red-500 font-medium">✗ Failed</span>}
                {savedCat === "stt" && <span className="text-xs text-primary">Saved ✓</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                Powered by echogarden (Whisper). Deploy downloads the model; Test runs a quick verification.
              </p>

              {/* STT saved configurations */}
              <div className="border-t pt-3 mt-2">
                <h3 className="text-xs font-semibold text-muted-foreground mb-2">Saved configurations</h3>
                {!settings.sttHistory?.length ? (
                  <div className="text-xs text-muted-foreground">No saved configs yet.</div>
                ) : (
                  <ul className="space-y-1">
                    {settings.sttHistory.map((h) => (
                      <li key={h.id} className="flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-xs cursor-pointer hover:bg-accent"
                        onClick={() => patchSettings({ engines: { ...e, stt: { ...e.stt, model: h.model } } })}>
                        <span className="font-medium">{h.model}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{new Date(h.ts).toLocaleString()}</span>
                          <button className="text-muted-foreground hover:text-red-500 shrink-0" onClick={(ev) => { ev.stopPropagation(); deleteSttHistory(h.id); }} title="Delete">✕</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* ---------------- TTS ---------------- */}
          {cat === "tts" && (
            <section className="note-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">Text-to-Speech</h2>
              <select
                className="select"
                value={e.tts.engine}
                onChange={(v) =>
                  patchSettings({ engines: { ...e, tts: { ...e.tts, engine: v.target.value } } })
                }
              >
                <option value="kokoro">Kokoro (local, neural)</option>
                <option value="openai">OpenAI-compatible (universal)</option>
                <option value="fish">Fish Audio (cloud)</option>
              </select>

              {/* Male / Female voice — dynamic per engine */}
              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="text-xs text-muted-foreground">Male voice</span>
                  {(e.tts.engine === "kokoro" && kokoroVoices.length > 0) ? (
                    <select className="select"
                      value={e.tts.maleVoice || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, maleVoice: v.target.value } } })}>
                      <option value="">— default —</option>
                      {kokoroVoices.filter((vv) => vv.gender === "male" && vv.language.startsWith("en"))
                        .map((vv) => (<option key={vv.name} value={vv.name}>{vv.name}</option>))}
                    </select>
                  ) : (
                    <input className="input"
                      placeholder={e.tts.engine === "fish" ? "reference_id for male" : "e.g. alloy, onyx"}
                      value={e.tts.maleVoice || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, maleVoice: v.target.value } } })} />
                  )}
                </label>
                <label className="flex-1">
                  <span className="text-xs text-muted-foreground">Female voice</span>
                  {(e.tts.engine === "kokoro" && kokoroVoices.length > 0) ? (
                    <select className="select"
                      value={e.tts.femaleVoice || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, femaleVoice: v.target.value } } })}>
                      <option value="">— default —</option>
                      {kokoroVoices.filter((vv) => vv.gender === "female" && vv.language.startsWith("en"))
                        .map((vv) => (<option key={vv.name} value={vv.name}>{vv.name}</option>))}
                    </select>
                  ) : (
                    <input className="input"
                      placeholder={e.tts.engine === "fish" ? "reference_id for female" : "e.g. nova, shimmer"}
                      value={e.tts.femaleVoice || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, femaleVoice: v.target.value } } })} />
                  )}
                </label>
              </div>

              {e.tts.engine === "kokoro" && (
                <>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Model</span>
                    <select
                      className="select"
                      value={e.tts.kokoroModel || "82m-v1.0-quantized"}
                      onChange={(v) =>
                        patchSettings({
                          engines: { ...e, tts: { ...e.tts, kokoroModel: v.target.value } },
                        })
                      }
                    >
                      <option value="82m-v1.0-quantized">82m v1.0 quantized (~80 MB)</option>
                      <option value="82m-v1.0-fp32">82m v1.0 fp32 (~330 MB, best quality)</option>
                    </select>
                  </label>
                  <div className="flex items-end gap-3">
                    <button
                      className="btn btn-secondary"
                      disabled={kokoroDeploying}
                      onClick={deployKokoro}
                    >
                      {kokoroDeploying ? "⏳ Deploying…" : "Deploy locally"}
                    </button>
                    {kokoroMsg && <span className="text-xs text-muted-foreground">{kokoroMsg}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Kokoro is a neural TTS model. First deploy downloads the model + voices from
                    HuggingFace; later runs are offline.
                  </p>
                </>
              )}

              {e.tts.engine === "fish" && (
                <>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">API key</span>
                    <input
                      className="input"
                      placeholder="sk-… from fish.audio"
                      value={e.tts.apiKey || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, apiKey: v.target.value } } })}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Model</span>
                    <select
                      className="select"
                      value={e.tts.fishModel || "s2.1-pro-free"}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, fishModel: v.target.value } } })}
                    >
                      <option value="s2.1-pro-free">s2.1-pro-free (free tier)</option>
                      <option value="s2.1-pro">s2.1-pro (latest pro)</option>
                      <option value="s2-pro">s2-pro</option>
                      <option value="s1">s1 (legacy)</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Base URL</span>
                    <input
                      className="input"
                      placeholder="https://api.fish.audio/v1/tts"
                      value={e.tts.baseUrl || ""}
                      onChange={(v) => patchSettings({ engines: { ...e, tts: { ...e.tts, baseUrl: v.target.value } } })}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Voice is picked from the male/female fields above. Get your API key at fish.audio.
                    If the official host is unreachable, enter a proxy/mirror URL above.
                  </p>
                </>
              )}

              {e.tts.engine === "openai" && (
                <>
                  <input
                    className="input"
                    placeholder="Base URL (e.g. http://localhost:8880/v1)"
                    value={e.tts.baseUrl || ""}
                    onChange={(v) =>
                      patchSettings({
                        engines: { ...e, tts: { ...e.tts, baseUrl: v.target.value } },
                      })
                    }
                  />
                  <input
                    className="input"
                    placeholder="API key (optional)"
                    value={e.tts.apiKey || ""}
                    onChange={(v) =>
                      patchSettings({
                        engines: { ...e, tts: { ...e.tts, apiKey: v.target.value } },
                      })
                    }
                  />
                  <input
                    className="input"
                    placeholder="Model (e.g. tts-1)"
                    value={e.tts.model || ""}
                    onChange={(v) =>
                      patchSettings({ engines: { ...e, tts: { ...e.tts, model: v.target.value } } })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Universal OpenAI-compatible endpoint — the same four fields (URL, API key, male/female
                    voice) work with OpenAI and most self-hosted / open-source TTS (CosyVoice, GPT-SoVITS,
                    XTTS, F5-TTS, Bark, etc.). The male/female voice fields map to the speaker names those
                    servers expect. Fish Audio uses a different wire format, so pick it from the dropdown
                    above when targeting fish.audio.
                  </p>
                </>
              )}

              {/* Save TTS audio toggle + output dir */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!e.tts.saveAudio}
                  onChange={(v) =>
                    patchSettings({ engines: { ...e, tts: { ...e.tts, saveAudio: v.target.checked } } })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  Save TTS audio to disk (off = real-time only, nothing saved)
                </span>
              </label>
              <p className="text-xs text-muted-foreground">
                TTS output folder: <code>{settings.libraryPath}/tts</code>
              </p>

              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={saveTts}>Save</button>
                <button className="btn btn-secondary" disabled={ttsTesting} onClick={testTts}>
                  {ttsTesting ? "Testing…" : "Test"}
                </button>
                {ttsTestOk === true && <span className="text-xs text-green-500 font-medium">✓ Working</span>}
                {ttsTestOk === false && <span className="text-xs text-red-500 font-medium">✗ Failed</span>}
                {savedCat === "tts" && <span className="text-xs text-primary">Saved ✓</span>}
              </div>

              {/* TTS saved configurations — draggable; first item is the default */}
              <div className="border-t pt-3 mt-2">
                <h3 className="text-xs font-semibold text-muted-foreground mb-2">Saved configurations</h3>
                {!settings.ttsHistory?.length ? (
                  <div className="text-xs text-muted-foreground">No saved configs yet.</div>
                ) : (
                  <ul className="space-y-1">
                    {settings.ttsHistory.map((h, i) => (
                      <li
                        key={h.id}
                        draggable
                        onDragStart={(ev) => { setDragTtsIdx(i); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(i)); }}
                        onDragOver={(ev) => { ev.preventDefault(); setOverTtsIdx(i); }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          if (dragTtsIdx !== null) reorderTts(dragTtsIdx, i);
                          setDragTtsIdx(null);
                          setOverTtsIdx(null);
                        }}
                        onDragEnd={() => { setDragTtsIdx(null); setOverTtsIdx(null); }}
                        className={`flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-xs cursor-pointer hover:bg-accent ${
                          dragTtsIdx === i ? "opacity-40" : ""
                        } ${overTtsIdx === i && dragTtsIdx !== null && dragTtsIdx !== i ? "ring-2 ring-yellow-400" : ""}`}
                        onClick={() => {
                          const tts: any = { ...e.tts };
                          if (h.model) {
                            if (h.engine === "kokoro") tts.kokoroModel = h.model;
                            else if (h.engine === "fish") tts.fishModel = h.model;
                            else tts.model = h.model;
                          }
                          // Restore male/female voices when the entry has them.
                          if (h.maleVoice !== undefined || h.femaleVoice !== undefined) {
                            tts.maleVoice = h.maleVoice || "";
                            tts.femaleVoice = h.femaleVoice || "";
                          } else if (h.voice) {
                            if (h.engine === "kokoro") tts.kokoroVoice = h.voice;
                            else if (h.engine === "fish") tts.maleVoice = h.voice;
                            else tts.voice = h.voice;
                          }
                          tts.engine = h.engine;
                          // Each saved config owns its URL + key; load them
                          // too (fall back to the live field only when this
                          // entry has none, so no credentials are lost).
                          tts.baseUrl = h.baseUrl ?? e.tts.baseUrl;
                          tts.apiKey = h.apiKey ?? e.tts.apiKey;
                          patchSettings({ engines: { ...e, tts } });
                        }}
                      >
                        <span className="text-muted-foreground/50 shrink-0 select-none cursor-grab" title="Drag to reorder">⠿</span>
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{h.voice || h.maleVoice || h.femaleVoice || "(default)"} · {h.engine}</span>
                          {i === 0 && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-600 text-[10px] font-semibold align-middle">
                              Default
                            </span>
                          )}
                        </div>
                        <span className="text-muted-foreground shrink-0">{new Date(h.ts).toLocaleString()}</span>
                        <button className="text-muted-foreground hover:text-red-500 shrink-0" onClick={(ev) => { ev.stopPropagation(); deleteTtsHistory(h.id); }} title="Delete">✕</button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  Drag to reorder. The top config is the default used for read-aloud; click any entry to load it.
                </p>
              </div>
            </section>
          )}

          {/* ---------------- LLM ---------------- */}
          {cat === "llm" && (
            <>
              <section className="note-card p-4 space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  LLM (default engine)
                </h2>
                <select
                  className="select"
                  value={e.llm.engine}
                  onChange={(v) =>
                    patchSettings({ engines: { ...e, llm: { ...e.llm, engine: v.target.value } } })
                  }
                >
                  <option value="ollama">Ollama (local)</option>
                  <option value="openai">OpenAI-compatible</option>
                </select>
                <input
                  className="input"
                  placeholder="Base URL (e.g. http://localhost:11434/v1)"
                  value={e.llm.baseUrl}
                  onChange={(v) =>
                    patchSettings({
                      engines: { ...e, llm: { ...e.llm, baseUrl: v.target.value } },
                    })
                  }
                />
                <input
                  className="input"
                  placeholder="Model (e.g. qwen3:0.6b)"
                  value={e.llm.model}
                  onChange={(v) =>
                    patchSettings({ engines: { ...e, llm: { ...e.llm, model: v.target.value } } })
                  }
                />
                <input
                  className="input"
                  placeholder="API key (optional)"
                  value={e.llm.apiKey || ""}
                  onChange={(v) =>
                    patchSettings({
                      engines: { ...e, llm: { ...e.llm, apiKey: v.target.value } },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Default engine for explanations, translations and word practice. Runs locally via
                  Ollama.
                </p>
                <div className="flex items-center gap-2">
                  <button className="btn btn-primary" onClick={confirmLlm}>
                    Confirm
                  </button>
                  <button className="btn btn-secondary" disabled={llmTesting} onClick={testLlm}>
                    {llmTesting ? "Testing…" : "Test"}
                  </button>
                  {llmTestOk === true && <span className="text-xs text-green-500 font-medium">✓ Working</span>}
                  {llmTestOk === false && <span className="text-xs text-red-500 font-medium">✗ Failed</span>}
                  {savedCat === "llm" && (
                    <span className="text-xs text-primary self-center">
                      Saved ✓ (added to history)
                    </span>
                  )}
                </div>
              </section>

              {/* Persisted history — won't disappear on reload */}
              <section className="note-card p-4 space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  Saved configurations
                </h2>
                {history.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    No saved configurations yet. Click “Confirm” above to record one.
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {history.map((h, i) => (
                      <li
                        key={h.id}
                        draggable
                        onDragStart={(ev) => { setDragLlmIdx(i); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(i)); }}
                        onDragOver={(ev) => { ev.preventDefault(); setOverLlmIdx(i); }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          if (dragLlmIdx !== null) reorderLlm(dragLlmIdx, i);
                          setDragLlmIdx(null);
                          setOverLlmIdx(null);
                        }}
                        onDragEnd={() => { setDragLlmIdx(null); setOverLlmIdx(null); }}
                        className={`flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-xs cursor-pointer hover:bg-accent ${
                          dragLlmIdx === i ? "opacity-40" : ""
                        } ${overLlmIdx === i && dragLlmIdx !== null && dragLlmIdx !== i ? "ring-2 ring-yellow-400" : ""}`}
                        onClick={() =>
                          patchSettings({
                            engines: {
                              ...e,
                              llm: {
                                ...e.llm,
                                engine: h.engine,
                                baseUrl: h.baseUrl,
                                model: h.model,
                                // Only overwrite the key field when this config
                                // actually stored one. Legacy entries (no apiKey)
                                // keep the live field untouched.
                                // Each saved config owns its key. Load this
                                // config's key verbatim (empty string when it
                                // has none) so switching models never inherits
                                // another model's key from the live field.
                                apiKey: h.apiKey ?? "",
                              },
                            },
                          })
                        }
                      >
                        <span className="text-muted-foreground/50 shrink-0 select-none cursor-grab" title="Drag to reorder">⠿</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="truncate">
                              {h.model} <span className="text-muted-foreground">· {h.engine}</span>
                            </span>
                            {i === 0 && (
                              <span className="ml-1 px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-600 text-[10px] font-semibold align-middle shrink-0">
                                Default
                              </span>
                            )}
                          </div>
                          <div className="text-muted-foreground truncate">{h.baseUrl}</div>
                          <div className="text-muted-foreground/70 text-[10px] mt-0.5">
                            {h.apiKey ? "🔑 API key saved with this config" : "🔓 no API key (uses field below)"}
                          </div>
                        </div>
                        <div className="text-muted-foreground shrink-0">
                          {new Date(h.ts).toLocaleString()}
                        </div>
                        <button className="text-muted-foreground hover:text-red-500 shrink-0" onClick={(ev) => { ev.stopPropagation(); deleteLlmHistory(h.id); }} title="Delete">✕</button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Drag to reorder. The top config is the default used everywhere (explanations, word
                  lookup, Ask AI); click any entry to load it into the form.
                </p>
              </section>

              {/* Custom prompts */}
              <section className="note-card p-4 space-y-3">
                <h2 className="text-sm font-semibold text-muted-foreground">Prompts</h2>
                <label className="block">
                  <span className="text-xs text-muted-foreground">Grammar (sentence) prompt</span>
                  <textarea
                    className="textarea"
                    rows={9}
                    placeholder={DEFAULT_GRAMMAR_PROMPT}
                    value={prompts.grammar}
                    onChange={(v) => {
                      setGrammarSaved(false);
                      patchSettings({ prompts: { ...prompts, grammar: v.target.value } });
                    }}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Leave the field empty to use the built-in default. Use <code>{"{L}"}</code> for the
                  learning language and <code>{"{N}"}</code> for the native language.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      patchSettings({ prompts: { ...prompts, grammar: prompts.grammar } });
                      setGrammarSaved(true);
                    }}
                  >
                    Save prompt
                  </button>
                  {grammarSaved && (
                    <span className="text-xs text-green-600">Saved ✓</span>
                  )}
                </div>
                {grammarSaved && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Saved “Grammar” prompt:</span>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg border p-2 bg-secondary">
                      {effGrammar}
                    </pre>
                  </div>
                )}
                <div className="flex gap-2">
                  <button className="btn btn-primary" onClick={confirmLlm}>
                    Confirm
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
