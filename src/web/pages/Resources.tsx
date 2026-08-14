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
            onDelete={() => remove(active)}
          />
        )}
      </div>
    </div>
  );
}
