// Settings → STT tab: Whisper model picker, deploy / test, saved configs.
import { useState } from "react";
import { api, type Settings } from "../../api";

const STT_MODELS = ["tiny", "base", "small", "medium", "large"];

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

  async function deploy() {
    setDeploying(true);
    setDeployMsg("⏳ Downloading Whisper model…");
    try {
      await api.ensureModel(settings.engines.stt.model);
      setDeployMsg("✅ Whisper ready – offline STT available");
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
      model: settings.engines.stt.model,
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
      await api.testStt();
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
  );
}
