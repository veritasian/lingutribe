// Settings → System tab: appearance (theme), languages, storage.
import { useState } from "react";
import { api, type Settings, type DiskUsage, fmtBytes } from "../../api";
import { applyTheme } from "../../App";
import { switchLang } from "../../lib/locale";

export default function SystemSection({
  settings,
  disk,
  patchSettings,
  savedCat,
  onSaved,
  reload,
}: {
  settings: Settings;
  disk: DiskUsage | null;
  patchSettings: (p: Partial<Settings>) => void;
  savedCat: string | null;
  onSaved: () => void;
  /** Re-fetch settings + disk from the server (used after saving). */
  reload: () => void;
}) {
  const [theme, setTheme] = useState(localStorage.getItem("lingo-theme") || "light");

  function setThemeMode(t: string) {
    setTheme(t);
    localStorage.setItem("lingo-theme", t);
    applyTheme(t);
    window.dispatchEvent(new Event("lingo-theme-change"));
  }

  async function save() {
    await api.saveSettings(settings);
    onSaved();
    await reload();
  }

  return (
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
        <button className="btn btn-primary" onClick={save}>
          Save
        </button>
        {savedCat === "system" && (
          <span className="text-xs text-primary self-center">Saved ✓</span>
        )}
      </div>
    </>
  );
}
