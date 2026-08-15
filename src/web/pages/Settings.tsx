// Settings page shell — left category rail + state, delegating each tab's
// UI and handlers to dedicated section components under ./settings/.
import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings, type DiskUsage } from "../api";
import { IconSettings, IconMic, IconVolume, IconRobot, IconBook } from "../components/Icon";
import SystemSection from "./settings/SystemSection";
import SttSection from "./settings/SttSection";
import TtsSection from "./settings/TtsSection";
import LlmSection from "./settings/LlmSection";
import DictSection from "./settings/DictSection";

type Cat = "system" | "stt" | "tts" | "llm" | "dict";

const CATS: { id: Cat; label: string; icon: ReactNode }[] = [
  { id: "system", label: "System", icon: <IconSettings size={18} /> },
  { id: "stt", label: "STT", icon: <IconMic size={18} /> },
  { id: "tts", label: "TTS", icon: <IconVolume size={18} /> },
  { id: "dict", label: "Dictionary", icon: <IconBook size={18} /> },
  { id: "llm", label: "LLM", icon: <IconRobot size={18} /> },
];

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [cat, setCat] = useState<Cat>("system");
  const [savedCat, setSavedCat] = useState<Cat | null>(null);

  async function load() {
    setSettings(await api.getSettings());
    setDisk(await api.getDisk());
  }
  useEffect(() => {
    load();
  }, []);

  function patchSettings(p: Partial<Settings>) {
    setSettings((s) => ({ ...(s as Settings), ...p }));
  }

  /** Flash the "Saved ✓" indicator for a category after a save/confirm. */
  function flash(c: Cat) {
    setSavedCat(c);
    setTimeout(() => setSavedCat(null), 2000);
  }

  if (!settings) return <div className="p-6 text-muted-foreground">Loading…</div>;

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
          {cat === "system" && (
            <SystemSection
              settings={settings}
              disk={disk}
              patchSettings={patchSettings}
              savedCat={savedCat}
              onSaved={() => flash("system")}
              reload={load}
            />
          )}
          {cat === "stt" && (
            <SttSection
              settings={settings}
              patchSettings={patchSettings}
              savedCat={savedCat}
              onSaved={() => flash("stt")}
            />
          )}
          {cat === "tts" && (
            <TtsSection
              settings={settings}
              patchSettings={patchSettings}
              savedCat={savedCat}
              onSaved={() => flash("tts")}
            />
          )}
          {cat === "dict" && (
            <DictSection
              settings={settings}
              patchSettings={patchSettings}
              savedCat={savedCat}
              onSaved={() => flash("dict")}
            />
          )}
          {cat === "llm" && (
            <LlmSection
              settings={settings}
              patchSettings={patchSettings}
              savedCat={savedCat}
              onSaved={() => flash("llm")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
