// Settings → STT tab: engine picker (Whisper via echogarden), model picker,
// deploy (auto-installs the model on demand) / test, saved configs.
import { useState } from "react";
import { api, type Settings } from "../../api";

const ENGINES: { id: string; label: string; models: string[] }[] = [
  { id: "echogarden", label: "Whisper (echogarden)", models: ["tiny", "base", "small", "medium"] },
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
  const [cocaTesting, setCocaTesting] = useState(false);
  const [cocaTestOk, setCocaTestOk] = useState<boolean | null>(null);
  const [cocaWord, setCocaWord] = useState("");
  const [cocaWordChecking, setCocaWordChecking] = useState(false);
  const [cocaWordResult, setCocaWordResult] = useState<{
    found: boolean;
    rank: number | null;
    band: string | null;
  } | null>(null);

  const e = settings.engines;
  const engine = e.stt.engine || "echogarden";
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

  async function testCoca() {
    setCocaTesting(true);
    setCocaTestOk(null);
    try {
      const r = await api.cocaTest();
      setCocaTestOk(!!r.ok);
    } catch {
      setCocaTestOk(false);
    } finally {
      setCocaTesting(false);
    }
  }

  async function testCocaWord() {
    const w = cocaWord.trim();
    if (!w) return;
    setCocaWordChecking(true);
    setCocaWordResult(null);
    try {
      const r = await api.cocaTest(w);
      setCocaWordResult({
        found: !!r.found,
        rank: r.rank ?? null,
        band: r.band ?? null,
      });
    } catch {
      setCocaWordResult({ found: false, rank: null, band: null });
    } finally {
      setCocaWordChecking(false);
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
        auto-installs); Test runs a quick verification. Whisper runs fully offline once deployed.
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

      {/* COCA frequency bands readiness test */}
      <div className="border-t pt-3 mt-2">
        <h3 className="text-xs font-semibold text-muted-foreground mb-2">COCA frequency bands</h3>
        <p className="text-xs text-muted-foreground mb-2">
          Word-frequency bands that color-code transcript words by rarity. Click to verify the
          bundled data loads.
        </p>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" disabled={cocaTesting} onClick={testCoca}>
            {cocaTesting ? "Testing…" : "Test COCA"}
          </button>
          {cocaTestOk === true && (
            <span className="text-xs text-green-500 font-medium">✓ Loaded</span>
          )}
          {cocaTestOk === false && (
            <span className="text-xs text-red-500 font-medium">✗ Failed</span>
          )}
        </div>

        <div className="border-t pt-3 mt-3 space-y-2">
          <span className="text-xs text-muted-foreground">Test if a word exists</span>
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="e.g. algorithm"
              value={cocaWord}
              onChange={(v) => setCocaWord(v.target.value)}
              onKeyDown={(ev) => ev.key === "Enter" && testCocaWord()}
            />
            <button
              className="btn btn-secondary"
              disabled={cocaWordChecking || !cocaWord.trim()}
              onClick={testCocaWord}
            >
              {cocaWordChecking ? "Checking…" : "Test word"}
            </button>
          </div>
          {cocaWordResult && (
            <div className="text-xs space-y-1">
              {cocaWordResult.found ? (
                <div className="text-green-500 font-medium">
                  ✓ <b>{cocaWord}</b> exists — rank {cocaWordResult.rank?.toLocaleString()}, band{" "}
                  {cocaWordResult.band}
                </div>
              ) : (
                <div className="text-amber-500 font-medium">
                  • <b>{cocaWord}</b> not found in the top bands (raw headword form)
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

