// Settings → STT tab: engine picker (Whisper / Moonshine), model picker,
// deploy (auto-installs the model on demand) / test, saved configs.
import { useState } from "react";
import { api, type Settings } from "../../api";

const ENGINES: { id: string; label: string; models: string[] }[] = [
  { id: "moonshine", label: "Moonshine (sherpa-onnx)", models: ["tiny", "base"] },
];

export default function SttSection({
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
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const [sttTesting, setSttTesting] = useState(false);
  const [sttTestOk, setSttTestOk] = useState<boolean | null>(null);

  const e = settings.engines;
  const engine = e.stt.engine || "moonshine";
  const engineMeta = ENGINES.find((x) => x.id === engine) || ENGINES[0];
  const engineLabel = engineMeta.label.split(" ")[0];

  function setEngine(id: string) {
    const models = ENGINES.find((x) => x.id === id)?.models || [];
    const model = models.includes(e.stt.model) ? e.stt.model : models[0];
    patchSettings({ engines: { ...e, stt: { ...e.stt, engine: id, model } } });
  }

  async function deploy() {
    setDeploying(true);
    setDeployMsg(`⏳ Downloading ${engineLabel} model…`);
    try {
      await api.ensureModel(e.stt.model, e.stt.engine);
      setDeployMsg(`✅ ${engineLabel} ready – offline STT available`);
    } catch (err: any) {
      setDeployMsg(`❌ ${err.message}`);
    } finally {
      setDeploying(false);
    }
  }

  async function saveStt() {
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      model: e.stt.model,
    };
    const history = [entry, ...(settings.sttHistory || [])].slice(0, 20);
    const next: Settings = { ...settings, sttHistory: history };
    patchSettings(next);
    await api.saveSettings(next);
    onSaved();
  }

  async function testStt() {
    setSttTesting(true);
    setSttTestOk(null);
    try {
      await api.testStt(e.stt.engine, e.stt.model);
      setSttTestOk(true);
    } catch {
      setSttTestOk(false);
    } finally {
      setSttTesting(false);
    }
  }

  function deleteSttHistory(id: number) {
    const next = { ...settings, sttHistory: (settings.sttHistory || []).filter((h) => h.id !== id) };
    patchSettings(next);
    api.saveSettings(next);
  }

  return (
    <section className="note-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">Speech-to-Text</h2>
      <div className="flex items-end gap-3">
        <label className="flex-1">
          <span className="text-xs text-muted-foreground">Engine</span>
          <select
            className="select"
            value={e.stt.engine}
            onChange={(v) => setEngine(v.target.value)}
          >
            {ENGINES.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className="text-xs text-muted-foreground">Model</span>
          <select
            className="select"
            value={e.stt.model}
            onChange={(v) =>
              patchSettings({ engines: { ...e, stt: { ...e.stt, model: v.target.value } } })
            }
          >
            {engineMeta.models.map((m) => (
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
        Powered by {engineLabel}. Deploy downloads the model automatically (first use also
        auto-installs); Test runs a quick verification. Moonshine is smaller & faster for English.
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
  );
}

