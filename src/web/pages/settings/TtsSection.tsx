// Settings → TTS tab: engine picker, male/female voices, per-engine fields,
// save/test, and the draggable saved-config list.
import { useEffect, useState } from "react";
import { api, type Settings, type KokoroVoice } from "../../api";

export default function TtsSection({
  settings,
  patchSettings,
  savedCat,
  onSaved,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  savedCat: string | null;
  onSaved: () => void;
}) {
  const [kokoroVoices, setKokoroVoices] = useState<KokoroVoice[]>([]);
  const [kokoroDeploying, setKokoroDeploying] = useState(false);
  const [kokoroMsg, setKokoroMsg] = useState("");
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestOk, setTtsTestOk] = useState<boolean | null>(null);
  const [dragTtsIdx, setDragTtsIdx] = useState<number | null>(null);
  const [overTtsIdx, setOverTtsIdx] = useState<number | null>(null);

  const e = settings.engines;

  // Lazily load the Kokoro voice list only when that engine is selected.
  useEffect(() => {
    if (settings?.engines.tts.engine === "kokoro" && kokoroVoices.length === 0) {
      api.getKokoroVoices().then(setKokoroVoices).catch(() => {});
    }
  }, [settings, kokoroVoices.length]);

  // When engine changes, clear maleVoice/femaleVoice so stale values from
  // another engine don't linger (e.g. Fish Audio reference_id in Kokoro).
  useEffect(() => {
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

  async function deployKokoro() {
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
      patchSettings(next);
      await api.saveSettings(next);
    } catch (err: any) {
      setKokoroMsg(`❌ ${err.message}`);
    } finally {
      setKokoroDeploying(false);
    }
  }

  async function saveTts() {
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
    patchSettings(next);
    await api.saveSettings(next);
    onSaved();
  }

  async function testTts() {
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

  function deleteTtsHistory(id: number) {
    const arr = (settings.ttsHistory || []).filter((h) => h.id !== id);
    // The first item is always the default; reassign after removal.
    const next = { ...settings, ttsHistory: arr, defaultTtsId: arr[0]?.id };
    patchSettings(next);
    api.saveSettings(next);
  }

  function reorderTts(from: number, to: number) {
    const arr = [...(settings.ttsHistory || [])];
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const next: Settings = { ...settings, ttsHistory: arr, defaultTtsId: arr[0]?.id };
    patchSettings(next);
    api.saveSettings(next);
  }

  return (
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
  );
}
