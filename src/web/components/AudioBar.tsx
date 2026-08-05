import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { IconPlay, IconPause } from "./Icon";

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Custom audio transport bar styled to match the app's global look:
 *   - dark background
 *   - white progress track
 *   - green played-progress
 * The actual playback is carried by the (hidden) <audio> element referenced
 * via `mediaRef`; this component is purely the visual transport + seek control.
 */
export default function AudioBar({
  mediaRef,
}: {
  mediaRef: RefObject<HTMLMediaElement | null>;
}) {
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => {
      if (!draggingRef.current) setCur(m.currentTime);
    };
    const onMeta = () => {
      setDur(m.duration || 0);
      setCur(m.currentTime);
    };
    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("timeupdate", onTime);
    m.addEventListener("durationchange", onMeta);
    m.addEventListener("loadedmetadata", onMeta);
    setPlaying(!m.paused);
    setDur(m.duration || 0);
    setCur(m.currentTime);
    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("timeupdate", onTime);
      m.removeEventListener("durationchange", onMeta);
      m.removeEventListener("loadedmetadata", onMeta);
    };
  }, [mediaRef]);

  function toggle() {
    const m = mediaRef.current;
    if (!m) return;
    if (m.paused) m.play().catch(() => {});
    else m.pause();
  }

  function seekFromClient(clientX: number) {
    const tr = trackRef.current;
    const m = mediaRef.current;
    if (!tr || !m || !dur) return;
    const r = tr.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const t = p * dur;
    m.currentTime = t;
    setCur(t);
  }

  function onTrackDown(e: React.MouseEvent) {
    draggingRef.current = true;
    seekFromClient(e.clientX);
    const move = (ev: MouseEvent) => seekFromClient(ev.clientX);
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const pct = dur > 0 ? (cur / dur) * 100 : 0;

  return (
    <div className="audio-bar">
      <button
        className="audio-play"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
      </button>
      <div className="audio-time">{fmt(cur)}</div>
      <div ref={trackRef} className="audio-track" onMouseDown={onTrackDown}>
        <div className="audio-fill" style={{ width: `${pct}%` }} />
        <div className="audio-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="audio-time">{fmt(dur)}</div>
    </div>
  );
}
