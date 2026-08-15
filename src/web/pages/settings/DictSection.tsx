// Settings → Dictionary tab: shows the offline MDict install path, lets the
// user test whether any dictionary is installed, choose which one to use for
// lookups, and reveals the folder in the OS file manager.
import { useEffect, useState } from "react";
import { api, type Settings } from "../../api";

type DictStatus = { ok: boolean; dir: string; count: number; titles: string[]; error?: string };

export default function DictSection({
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
  const [testing, setTesting] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<DictStatus | null>(null);

  // Populate the installed-dictionary list as soon as this tab opens.
  useEffect(() => {
    testDict();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function testDict() {
    setTesting(true);
    try {
      setStatus(await api.dictStatus());
    } catch (e: any) {
      setStatus({ ok: false, dir: "", count: 0, titles: [], error: e.message });
    } finally {
      setTesting(false);
    }
  }

  async function reveal() {
    setRevealing(true);
    try {
      const dir = status?.dir || (await api.dictStatus()).dir;
      if (!dir) {
        setStatus({ ok: false, dir: "", count: 0, titles: [], error: "Unknown dictionary folder" });
        return;
      }
      await api.revealFolder(dir);
    } catch (e: any) {
      /* ignore — reveal is best-effort */
    } finally {
      setRevealing(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.saveSettings(settings);
      onSaved();
    } catch (e: any) {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="note-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Offline Dictionary (MDict)</h2>
        <p className="text-xs text-muted-foreground">
          Drop <code>.mdx</code> files into the folder below — no internet needed, word lookups are
          fully local. After adding a file, click <b>Test install</b> to confirm it is detected.
        </p>

        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" disabled={testing} onClick={testDict}>
            {testing ? "Testing…" : "Test install"}
          </button>
          <button className="btn btn-secondary" disabled={revealing} onClick={reveal}>
            {revealing ? "Opening…" : "Reveal folder"}
          </button>
        </div>

        {status && (
          <div className="text-xs space-y-1">
            {status.ok ? (
              <div className="text-green-500 font-medium">✓ {status.count} dictionary(ies) installed</div>
            ) : (
              <div className="text-red-500 font-medium">✗ No dictionary installed yet</div>
            )}
            {status.dir && (
              <div className="text-muted-foreground break-all">Default path: {status.dir}</div>
            )}
            {status.titles?.length ? (
              <ul className="list-disc pl-4 text-muted-foreground">
                {status.titles.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : null}
            {status.error && <div className="text-red-500">{status.error}</div>}
          </div>
        )}

        {status && status.count > 1 && (
          <label className="block">
            <span className="text-xs text-muted-foreground">
              Active dictionary (used for word lookups)
            </span>
            <select
              className="select mt-1"
              value={settings.activeDictionary || ""}
              onChange={(v) => patchSettings({ activeDictionary: v.target.value || null })}
            >
              <option value="">Auto — first dictionary that has the word</option>
              {status.titles.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">
              When more than one dictionary is installed, pick one to always interpret words with it.
              “Auto” searches every dictionary and uses the first match.
            </p>
          </label>
        )}

        <p className="text-xs text-muted-foreground">
          The default install path is inside Application Support so the read-only app bundle is never
          written to. Place your <code>.mdx</code> files there (or use Reveal folder to open it).
        </p>
      </section>

      {status && status.count > 0 && (
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          {savedCat === "dict" && (
            <span className="text-xs text-primary self-center">Saved ✓</span>
          )}
        </div>
      )}
    </>
  );
}
