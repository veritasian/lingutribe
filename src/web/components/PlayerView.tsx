// Layout (top → bottom, left → right):
//   1. Header bar: title + [Transcribe] [Speed] [Delete]
//   2. Audio controls (audio only)
//   3. Waveform (collapsible)
//   4. Horizontal split:
//        Left:  video / audio player
//        Right: tab strip [Transcript | Layout] + scrollable content
//   5. Right slide-in WordPanel
import { useEffect, useRef, useState } from "react";
import WaveformPlayer from "./WaveformPlayer";
import Transcript from "./Transcript";
import VocabProfile from "./VocabProfile";
import WordPanel, { type WordPanelData } from "./WordPanel";
import {
  useCoca,
  useVisibleBands,
  BAND_META,
  type Band,
} from "../lib/coca";
import { type Resource, type WordHit } from "../api";
import {
  IconAudio,
  IconMic,
  IconTrash,
  IconChevronDown,
} from "./Icon";

const MIN_SPLIT = 200;
const MAX_SPLIT_PCT = 0.75; // max 75% of total width
const DEFAULT_SPLIT_PCT = 0.45; // default left column = 45%

export default function PlayerView({
  resource,
  onTranscribe,
  onDelete,
  busy,
}: {
  resource: Resource;
  onTranscribe?: () => void;
  onDelete?: () => void;
  busy?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const isVideo = resource.type === "video";

  const coca = useCoca();
  const [visBands, toggleBand] = useVisibleBands();

  // Horizontal split: left (player) / right (transcript).
  const [splitPct, setSplitPct] = useState(DEFAULT_SPLIT_PCT);
  useEffect(() => {
    const raw = localStorage.getItem("lingo-split-pct");
    if (raw) {
      const n = Number(raw);
      if (n >= MIN_SPLIT) setSplitPct(n);
    }
  }, []);

  // Horizontal drag-resize
  function onSplitDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const parentW = splitRef.current?.parentElement?.offsetWidth || 1200;
    const startPct = splitPct;
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = Math.max(
        MIN_SPLIT / parentW,
        Math.min(MAX_SPLIT_PCT, startPct + dx / parentW)
      );
      setSplitPct(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  useEffect(() => {
    localStorage.setItem("lingo-split-pct", String(splitPct));
  }, [splitPct]);

  // Word-sync index
  const [activeIdx, setActiveIdx] = useState(-1);
  const [autoscroll, setAutoscroll] = useState(
    () => localStorage.getItem("lingo-autoscroll") !== "0"
  );
  useEffect(() => {
    localStorage.setItem("lingo-autoscroll", autoscroll ? "1" : "0");
  }, [autoscroll]);

  const words: WordHit[] =
    typeof resource.words === "string"
      ? JSON.parse(resource.words || "[]")
      : resource.words || [];

  // Right slide-in panel
  const [panel, setPanel] = useState<WordPanelData | null>(null);

  function onWordClick(d: { text: string; context: string; isWord: boolean; band: Band }) {
    setPanel({
      text: d.text,
      context: d.context,
      isWord: d.isWord,
      rank: null,
      band: d.band,
    });
  }

  function seek(t: number) {
    if (isVideo && videoRef.current) {
      videoRef.current.currentTime = t;
      videoRef.current.play().catch(() => {});
    } else if (audioRef.current) {
      audioRef.current.currentTime = t;
      audioRef.current.play().catch(() => {});
    }
  }

  // Spacebar play/pause
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tgt?.isContentEditable)
        return;
      const media = isVideo ? videoRef.current : audioRef.current;
      if (!media) return;
      e.preventDefault();
      if (media.paused) media.play().catch(() => {});
      else media.pause();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isVideo]);

  // Collapse
  const [showWave, setShowWave] = useState(
    () => localStorage.getItem("lingo-show-wave") !== "0"
  );
  useEffect(() => {
    localStorage.setItem("lingo-show-wave", showWave ? "1" : "0");
  }, [showWave]);

  // Tab
  const [playerTab, setPlayerTab] = useState<"transcript" | "layout">("transcript");

  const mediaRef = isVideo ? videoRef : audioRef;
  const hasContent = words.length > 0 || resource.transcript;

  // Shared tab bar + content (Transcript / Layout)
  function TabContent() {
    return (
      <>
        <div className="flex items-center border rounded-md overflow-hidden text-xs mb-6 shrink-0 w-fit">
          <button
            className={`px-3 py-1 ${playerTab === "transcript" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            onClick={() => setPlayerTab("transcript")}
          >
            Transcript
          </button>
          <button
            className={`px-3 py-1 ${playerTab === "layout" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            onClick={() => setPlayerTab("layout")}
          >
            Layout
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {playerTab === "transcript" ? (
            hasContent ? (
              <Transcript
                words={words}
                transcript={resource.transcript || ""}
                onSeek={seek}
                activeIdx={activeIdx}
                scrollIntoView={autoscroll}
                onWordClick={onWordClick}
                onAskAi={(text) =>
                  setPanel({
                    text,
                    context: text,
                    isWord: false,
                    defaultTab: "ask",
                    thread: resource.id,
                    article: resource.transcript || "",
                  })
                }
                visBands={visBands}
                onToggleBand={toggleBand}
              />
            ) : (
              <div className="text-sm text-muted-foreground">No transcript yet.</div>
            )
          ) : (
            <div>
              {coca && (
                <div className="flex items-center gap-2 flex-wrap text-xs mb-4">
                  <span className="text-muted-foreground">COCA filter</span>
                  {(Object.keys(BAND_META) as Array<keyof typeof BAND_META>).map((b) => {
                    const m = BAND_META[b];
                    const on = visBands.has(b);
                    return (
                      <button
                        key={b}
                        onClick={() => toggleBand(b, !on)}
                        className="px-2 py-0.5 rounded-full border transition-opacity"
                        style={{
                          borderColor: m.color,
                          color: on ? m.color : "hsl(var(--muted-foreground))",
                          background: on ? `rgba(${m.rgb},0.12)` : "transparent",
                          opacity: on ? 1 : 0.45,
                        }}
                        title={`${m.description} (click to ${on ? "hide" : "show"})`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <VocabProfile coca={coca} words={words} transcript={resource.transcript}
                onWordClick={(w) => setPanel({ text: w, context: w, isWord: true, rank: null, band: null })} />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="h-full min-w-0 flex">
      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-3 shrink-0 flex items-center justify-center gap-3 border-b relative">
          <h1 className="text-[15px] font-semibold truncate text-center">{resource.name}</h1>
          <div className="flex items-center gap-2 absolute right-6">
            {onTranscribe && (
              <button
                className="btn btn-secondary inline-flex items-center gap-1"
                disabled={busy}
                onClick={onTranscribe}
              >
                <IconMic size={15} /> {words.length > 0 ? "Re-transcribe" : "Transcribe"}
              </button>
            )}
            <SpeedControl mediaRef={mediaRef} />
            {onDelete && (
              <button className="btn btn-ghost inline-flex items-center gap-1" onClick={onDelete}>
                <IconTrash size={15} /> Delete
              </button>
            )}
          </div>
        </div>

        {/* Audio controls bar (audio only — video has its own built-in) */}
        {!isVideo && (
          <div className="px-6 pt-3 shrink-0">
            <audio
              key={resource.id}
              controls
              className="w-full"
              src={`/api/resources/${resource.id}/file`}
              ref={audioRef}
            />
            <div className="text-[11px] text-muted-foreground mt-1">
              {words.length} words · {resource.transcript ? "transcribed" : "not transcribed"}
            </div>
          </div>
        )}

        {/* Waveform */}
        <div className="px-6 shrink-0 pt-3">
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full mb-1"
            onClick={() => setShowWave((v) => !v)}
          >
            <span
              style={{
                display: "inline-flex",
                transform: showWave ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.15s",
              }}
            >
              <IconChevronDown size={12} />
            </span>
            Waveform{!showWave && " (hidden)"}
          </button>
          {showWave && (
            <WaveformPlayer
              key={resource.id}
              resource={resource}
              mediaRef={mediaRef}
              onTimeUpdate={(_t, idx) => setActiveIdx(idx)}
              autoscroll={autoscroll}
              onToggleAutoscroll={() => setAutoscroll((v) => !v)}
            />
          )}
        </div>

        {/* Content area: split (video) or single-column (audio). On mobile,
            video collapses to single column (video top, transcript bottom). */}
        {isVideo ? (
          <div ref={splitRef} className="flex-1 min-h-0 flex flex-col lg:flex-row mt-3">
            {/* Left: player */}
            <div
              className="shrink-0 overflow-hidden flex flex-col px-6 pb-4 lg:pb-0"
              style={{
                flexBasis: `calc(${splitPct * 100}% - 4px)`,
                width: "100%",
              }}
            >
              <video
                key={resource.id}
                ref={videoRef}
                src={`/api/resources/${resource.id}/file`}
                controls
                className="w-full rounded-lg bg-black"
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  const idx = words.length > 0
                    ? words.findIndex((w) => t >= w.start && t < w.end)
                    : -1;
                  if (idx !== activeIdx) setActiveIdx(idx);
                }}
              />
            </div>
            {/* Resize handle — desktop only */}
            <div
              className="hidden lg:block w-2 cursor-col-resize shrink-0 bg-transparent hover:bg-primary/20 active:bg-primary/30 transition-colors rounded"
              onMouseDown={onSplitDrag}
              title="Drag to resize columns"
            />
            {/* Right: tabs + transcript */}
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden px-6 lg:px-0 lg:pr-6">
              <TabContent />
            </div>
          </div>
        ) : (
          /* Audio: single-column, transcript centred with max width */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden mt-3 px-6">
            <div className="max-w-2xl mx-auto w-full flex-1 min-h-0 flex flex-col overflow-hidden">
              <TabContent />
            </div>
          </div>
        )}
      </div>

      {/* Right slide-in panel */}
      <WordPanel
        data={panel}
        onClose={() => setPanel(null)}
        onAdded={(term) => {
          console.log("added", term);
        }}
      />
    </div>
  );
}

function SpeedControl({ mediaRef }: { mediaRef: React.RefObject<HTMLMediaElement> }) {
  const [rate, setRate] = useState(1);
  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = rate;
  }, [rate, mediaRef]);
  const opts = [0.5, 0.75, 1, 1.25, 1.5, 2];
  return (
    <select
      className="select"
      style={{ width: 70, padding: "3px 6px", fontSize: 12 }}
      value={rate}
      onChange={(e) => setRate(Number(e.target.value))}
    >
      {opts.map((o) => (
        <option key={o} value={o}>{o}×</option>
      ))}
    </select>
  );
}
