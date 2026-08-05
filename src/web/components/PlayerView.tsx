// Layout (top → bottom, left → right):
//   1. Header bar: [Transcribe] [Speed] [Delete]
//   2. Audio controls (audio only)
//   3. Waveform (collapsible)
//   4. Horizontal split:
//        Left:  video / audio player
//        Right: tab strip [Transcript | Statistics] + scrollable content
//   5. Right slide-in WordPanel
import { useEffect, useMemo, useRef, useState } from "react";
import WaveformPlayer from "./WaveformPlayer";
import Caption from "./Caption";
import AudioBar from "./AudioBar";
import Transcript from "./Transcript";
import VocabProfile from "./VocabProfile";
import WordPanel, { type WordPanelData } from "./WordPanel";
import {
  useCoca,
  useVisibleBands,
  BAND_META,
  type Band,
} from "../lib/coca";
import { type Resource, type WordHit, api, type Analysis } from "../api";
import {
  IconAudio,
  IconMic,
  IconTrash,
  IconChevronDown,
} from "./Icon";
import { buildSegments, type Segment } from "../lib/segments";

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
  const isVideo = resource.type === "video";

  const coca = useCoca();
  const [visBands, toggleBand] = useVisibleBands();

  // Word-sync index
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeIdxRef = useRef(-1);

  // ── Segment model + play mode ──
  const words: WordHit[] = useMemo(
    () =>
      typeof resource.words === "string"
        ? JSON.parse(resource.words || "[]")
        : resource.words || [],
    [resource.words]
  );

  // Pre-computed analysis cache (peaks, segments, duration). Once fetched,
  // opens are zero-DSP: subtitle list, duration, and waveform peaks all load
  // from disk instead of being re-derived.
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  useEffect(() => {
    let cancel = false;
    setAnalysis(null);
    api.getAnalysis(resource.id).then((d) => {
      if (!cancel && d) setAnalysis(d);
    });
    return () => {
      cancel = true;
    };
  }, [resource.id]);

  const segments: Segment[] = useMemo(() => {
    if (analysis?.segments && analysis.segments.length) return analysis.segments;
    return buildSegments(words);
  }, [words, analysis]);

  const initialDuration = analysis?.duration ?? 0;

  const [activeSegIdx, setActiveSegIdx] = useState(-1);
  const activeSegIdxRef = useRef(-1);

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

  /** Called from a subtitle row click — receives the row's full Segment. */
  function seekSegmentByRef(s: Segment) {
    seek(s.startTime);
  }

  // Master playhead-sync effect. Replaces the per-component onTimeUpdate
  // handlers (WaveformPlayer's WS callback and the inline <video> handler).
  // Updates activeIdx (word), activeSegIdx (segment), and applies the
  // play-mode auto-advance rule.
  const mediaRef = isVideo ? videoRef : audioRef;
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    function tick() {
      if (!media) return;
      const t = media.currentTime;
      // word level
      let wIdx = -1;
      if (words.length > 0) {
        // Linear scan is fine for typical transcripts.
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          if (t >= w.start && t < w.end) { wIdx = i; break; }
        }
      }
      if (wIdx !== activeIdxRef.current) {
        activeIdxRef.current = wIdx;
        setActiveIdx(wIdx);
      }
      // segment level
      let sIdx = -1;
      if (segments.length > 0) {
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          if (t >= s.startTime && t < s.endTime) { sIdx = i; break; }
        }
      }
      if (sIdx !== activeSegIdxRef.current) {
        activeSegIdxRef.current = sIdx;
        setActiveSegIdx(sIdx);
      }
    }
    media.addEventListener("timeupdate", tick);
    tick();
    return () => media.removeEventListener("timeupdate", tick);
  }, [words.length, segments.length, mediaRef, resource.id]);

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
  // Video subtitles visibility (toggle to hide captions, show only video).
  const [showSubs, setShowSubs] = useState(true);

  // Statistics page (COCA filter chips + vocabulary profile).
  function renderStatistics() {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-4">
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
        <VocabProfile
          coca={coca}
          words={words}
          transcript={resource.transcript}
          onWordClick={(w) =>
            setPanel({ text: w, context: w, isWord: true, rank: null, band: null })
          }
        />
      </div>
    );
  }

  return (
    <div className="h-full min-w-0 flex">
      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-2 shrink-0 flex items-center justify-between gap-2 border-b">
          {/* Left: menu tabs (page categories) */}
          <div className="flex items-center gap-1">
            <button
              className={`hdr-tab ${playerTab === "transcript" ? "active" : ""}`}
              onClick={() => setPlayerTab("transcript")}
            >
              Transcript
            </button>
            <button
              className={`hdr-tab ${playerTab === "layout" ? "active" : ""}`}
              onClick={() => setPlayerTab("layout")}
            >
              Statistics
            </button>
          </div>
          {/* Right: actions */}
          <div className="flex items-center gap-2">
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

        {/* Audio transport (audio only — video has its own built-in). The
            hidden <audio> carries playback; AudioBar is the styled transport. */}
        {!isVideo && (
          <div className="px-6 pt-3 shrink-0">
            <audio
              key={resource.id}
              ref={audioRef}
              src={`/api/resources/${resource.id}/file`}
              style={{ display: "none" }}
            />
            <AudioBar mediaRef={audioRef} />
            <div className="text-[11px] text-muted-foreground mt-2">
              {words.length} words · {resource.transcript ? "transcribed" : "not transcribed"}
              {segments.length > 0 && ` · ${segments.length} segments`}
            </div>
          </div>
        )}

        {/* Waveform (audio only — video shows no waveform) */}
        {!isVideo && (
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
                initialDuration={initialDuration}
              />
            )}
          </div>
        )}

        {/* Live caption (MDN <track> model): shows only the current cue and
            switches in real time with playback — no list scrolling. Audio only;
            video shows its own subtitle list below the player. */}
        {!isVideo && segments.length > 0 && (
          <div className="px-6 shrink-0">
            <Caption segments={segments} mediaRef={mediaRef} />
          </div>
        )}

        {/* Content area */}
        {isVideo ? (
          /* Video: single column — player on top, divider, then the selected
             page (subtitle list with hide toggle, or statistics). No waveform,
             no left/right split. */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden mt-8 px-8 py-6">
            <video
              key={resource.id}
              ref={videoRef}
              src={`/api/resources/${resource.id}/file`}
              controls
              className="w-full rounded-lg bg-black max-h-[52vh] object-contain shrink-0"
            />
            <div className="subtitle-divider" />
            {playerTab === "transcript" ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-1 pt-1 pb-2 shrink-0">
                  <span className="text-sm font-medium">字幕 Subtitles</span>
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={() => setShowSubs((v) => !v)}
                  >
                    {showSubs ? "隐藏 Hide" : "显示 Show"}
                  </button>
                </div>
                {showSubs && (
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <Transcript
                      words={words}
                      transcript={resource.transcript || ""}
                      onSeek={seek}
                      activeIdx={activeIdx}
                      activeSegIdx={activeSegIdx}
                      segments={segments}
                      onSeekSegment={seekSegmentByRef}
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
                  </div>
                )}
              </div>
            ) : (
              renderStatistics()
            )}
          </div>
        ) : (
          /* Audio: single-column, transcript / statistics centred with max width */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden mt-8 px-8 py-6">
            <div className="max-w-2xl mx-auto w-full flex-1 min-h-0 flex flex-col overflow-hidden">
              {playerTab === "transcript" ? (
                <Transcript
                  words={words}
                  transcript={resource.transcript || ""}
                  onSeek={seek}
                  activeIdx={activeIdx}
                  activeSegIdx={activeSegIdx}
                  segments={segments}
                  onSeekSegment={seekSegmentByRef}
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
                renderStatistics()
              )}
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
