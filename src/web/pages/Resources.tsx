import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type Resource } from "../api";
import PlayerView from "../components/PlayerView";
import {
  IconAudio,
  IconVideo,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconAlign,
} from "../components/Icon";

type Tab = "audio" | "video";

export default function Resources() {
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const current: Tab = tabParam === "video" ? "video" : "audio";

  const [items, setItems] = useState<Resource[]>([]);
  const [active, setActive] = useState<Resource | null>(null);
  const [tab, setTab] = useState<Tab>(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [listOpen, setListOpen] = useState(
    () => localStorage.getItem("lingo-res-list") !== "collapsed"
  );
  const [mode, setMode] = useState<"file" | "url">("file");
  const [urlInput, setUrlInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Align modal — lets the user align the audio to a known/corrected
  // transcript (or just the existing one) for precise word timing.
  const [alignOpen, setAlignOpen] = useState(false);
  const [alignText, setAlignText] = useState("");
  const [alignLang, setAlignLang] = useState("en");

  // Sync the local tab to the route (left-nav selection drives the URL).
  useEffect(() => {
    setTab(current);
    setActive(null);
  }, [current]);

  function toggleList() {
    setListOpen((v) => {
      const next = !v;
      localStorage.setItem("lingo-res-list", next ? "open" : "collapsed");
      return next;
    });
  }

  async function load() {
    setItems(await api.listResources());
  }
  useEffect(() => {
    load();
  }, []);

  // Auto-select the first resource in the list when entering the tab.
  useEffect(() => {
    const list = items.filter((r) => r.type === tab);
    if (list.length > 0 && !active) {
      setActive(list[0]);
    }
  }, [items, tab, active]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setMsg("");
    try {
      // The left-nav route already chose the type — just upload as that.
      const type: Tab = current;
      const row = await api.uploadResource(f, type, f.name);
      setMsg(`Uploaded: ${row.name}`);
      await load();
      navigate("/resources/" + type);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function transcribe(r: Resource) {
    setBusy(true);
    setMsg("Transcribing… (first run downloads the model)");
    try {
      const res: any = await api.transcribeResource(r.id, "en");
      if (res?.skipped) {
        setMsg("Already has subtitles — kept existing transcript (no re-STT)");
      } else {
        setMsg("Transcription done");
      }
      await load();
      setActive({ ...r, transcript: res.transcript, words: res.words });
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Resource) {
    await api.deleteResource(r.id);
    if (active?.id === r.id) setActive(null);
    await load();
  }

  // Open the align dialog pre-filled with the resource's current transcript.
  function openAlign(r: Resource) {
    const existing =
      typeof r.transcript === "string"
        ? r.transcript
        : (r.transcript as any) || "";
    setAlignText(existing || "");
    setAlignLang("en");
    setAlignOpen(true);
  }

  async function runAlign() {
    if (!active) return;
    const text = alignText.trim();
    if (!text) {
      setMsg("Enter a transcript to align against.");
      return;
    }
    setBusy(true);
    setMsg("Aligning transcript to audio… (first run downloads eSpeak)");
    try {
      const res: any = await api.alignResource(active.id, text, alignLang);
      const wc = res.words?.length ?? 0;
      setMsg(`Aligned ✓ — ${wc} words with precise timing`);
      setAlignOpen(false);
      await load();
      setActive({ ...active, transcript: res.transcript, words: res.words });
    } catch (err: any) {
      setMsg(`Align error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onImportUrl() {
    const u = urlInput.trim();
    if (!u) return;
    setBusy(true);
    setMsg(`Importing from URL… (this may take a while)`);
    try {
      const row = await api.importUrl(u, current);
      setMsg(`Imported: ${row.name}${row.words?.length ? ` · ${row.words.length} words from subtitles` : " · no subtitles (use Transcribe later)"}`);
      setUrlInput("");
      await load();
      if (row.words?.length) {
        setActive({ ...row, words: row.words });
      } else {
        setActive(row);
      }
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const filtered = items.filter((r) => r.type === tab);

  return (
    <div className="flex h-full">
      {/* list + tabs — collapsible left column */}
      {listOpen ? (
        <div className="w-[340px] border-r flex flex-col shrink-0">
          <div className="border-b">
            <div className="px-4 h-14 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold capitalize">{tab}</h2>
              <button
                className="toggle-circle-btn"
                onClick={toggleList}
                title="Collapse list"
                aria-label="Collapse list"
              >
                <IconChevronLeft size={18} />
              </button>
            </div>
            <div className="px-4 pb-3">
            {/* Source mode: local file or URL */}
            <div className="flex items-center border rounded-md overflow-hidden text-xs">
              <button
                className={`flex-1 px-2 py-1 ${mode === "file" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                onClick={() => setMode("file")}
              >
                Local file
              </button>
              <button
                className={`flex-1 px-2 py-1 ${mode === "url" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                onClick={() => setMode("url")}
              >
                {tab === "video" ? "Video link" : "Podcast link"}
              </button>
            </div>
            {mode === "file" ? (
              <button
                className="btn btn-primary w-full mt-2 inline-flex items-center justify-center gap-1"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                <IconPlus size={15} /> Add {tab === "video" ? "video" : "audio"}
              </button>
            ) : (
              <div className="mt-2 flex gap-1">
                <input
                  className="input flex-1"
                  style={{ padding: "6px 8px" }}
                  placeholder={tab === "video" ? "https://youtu.be/…" : "https://feeds.megaphone.fm/…"}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onImportUrl()}
                />
                <button
                  className="btn btn-primary inline-flex items-center"
                  disabled={busy || !urlInput.trim()}
                  onClick={onImportUrl}
                >
                  Import
                </button>
              </div>
            )}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={onUpload}
            accept={current === "audio" ? "audio/*" : "video/*"}
          />
        <div className="scroll flex-1 p-2 space-y-1">
          {filtered.length === 0 && (
            <div className="text-sm text-muted-foreground p-4">No {tab} resources yet.</div>
          )}
          {filtered.map((r) => (
            <div
              key={r.id}
              className={`sidebar-item ${active?.id === r.id ? "active" : ""}`}
              onClick={() => setActive(r)}
            >
              {r.type === "audio" ? <IconAudio size={18} /> : <IconVideo size={18} />}
              <span className="truncate flex-1">{r.name}</span>
            </div>
          ))}
        </div>
      </div>
      ) : null}

      {/* play area — full width */}
      <div className="flex-1 min-w-0 relative">
        {!listOpen && (
          <button
            className="toggle-circle-btn absolute top-3 left-3 z-10"
            onClick={toggleList}
            title="Expand list"
            aria-label="Expand list"
          >
            <IconChevronRight size={18} />
          </button>
        )}
        {msg && <div className="text-xs text-muted-foreground mb-3 px-6 pt-4">{msg}</div>}
        {!active && (
          <div className="p-6 text-muted-foreground">Select a {tab} resource to view.</div>
        )}
        {active && (
          <PlayerView
            resource={active}
            busy={busy}
            onTranscribe={() => transcribe(active)}
            onAlign={() => openAlign(active)}
            onDelete={() => remove(active)}
          />
        )}
      </div>

      {/* Align dialog — align audio to a known/corrected transcript */}
      {alignOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onMouseDown={() => !busy && setAlignOpen(false)}
        >
          <div
            className="bg-background border rounded-xl shadow-xl w-[min(640px,92vw)] max-h-[86vh] flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b flex items-center gap-2">
              <IconAlign size={18} />
              <h3 className="text-[15px] font-semibold">Align transcript to audio</h3>
              <button
                className="ml-auto icon-btn"
                disabled={busy}
                onClick={() => setAlignOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="px-5 py-3 text-xs text-muted-foreground border-b">
              Forced alignment maps each word of the text below to its exact
              moment in the audio, giving precise click-to-seek and karaoke
              highlighting. Edit the text if you have a cleaner script than the
              current transcript.
            </div>
            <textarea
              className="textarea m-5 flex-1 min-h-[180px] resize-none font-mono text-[13px] leading-6"
              value={alignText}
              disabled={busy}
              placeholder="Paste or edit the transcript to align…"
              onChange={(e) => setAlignText(e.target.value)}
            />
            <div className="px-5 pb-3 flex items-center gap-3">
              <label className="text-xs text-muted-foreground flex items-center gap-2">
                Language
                <select
                  className="select"
                  style={{ width: "auto" }}
                  value={alignLang}
                  disabled={busy}
                  onChange={(e) => setAlignLang(e.target.value)}
                >
                  <option value="en">English (en)</option>
                  <option value="fr">French (fr)</option>
                  <option value="de">German (de)</option>
                  <option value="es">Spanish (es)</option>
                  <option value="it">Italian (it)</option>
                  <option value="pt">Portuguese (pt)</option>
                  <option value="ja">Japanese (ja)</option>
                  <option value="zh">Chinese (zh)</option>
                  <option value="ko">Korean (ko)</option>
                  <option value="ru">Russian (ru)</option>
                </select>
              </label>
              <div className="ml-auto flex items-center gap-2">
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setAlignOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary inline-flex items-center gap-1"
                  disabled={busy || !alignText.trim()}
                  onClick={runAlign}
                >
                  {busy ? "Aligning…" : "Align"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
