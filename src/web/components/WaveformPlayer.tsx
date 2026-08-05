import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { type Resource } from "../api";

// Audio surface kept intentionally minimal: just the decoded waveform bars
// plus a bottom time axis. All overlays (pitch contour, stress bands, word
// dots, zoom/scroll rails, resize handle) were removed to keep the process
// light and the view focused on the waveform.

const DEFAULT_PPS = 180; // pixels per second at default zoom
const DEFAULT_WAVE_H = 120; // fixed default waveform height

export default function WaveformPlayer({
  resource,
  mediaRef,
  initialDuration = 0,
}: {
  resource: Resource;
  mediaRef: React.RefObject<HTMLMediaElement>;
  /** Cached duration from server analysis (if known). */
  initialDuration?: number;
}) {
  const waveMountRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(initialDuration || 0);

  const totalW = Math.max(1, Math.round((duration || 1) * DEFAULT_PPS));

  useEffect(() => {
    if (!waveMountRef.current || !mediaRef.current) return;
    setReady(false);

    const ws = WaveSurfer.create({
      container: waveMountRef.current,
      media: mediaRef.current,
      height: DEFAULT_WAVE_H,
      // enjoy-style: thin, dense bars with a soft grey, follow theme via currentColor.
      waveColor: "rgba(127, 137, 145, 0.55)",
      progressColor: "hsl(var(--primary))",
      barWidth: 1, // thinner
      barGap: 1, // small gap
      barRadius: 0, // no rounded tops — cleaner look
      cursorWidth: 1,
      cursorColor: "hsl(var(--primary))",
      normalize: true,
      fillParent: true,
    });
    wsRef.current = ws;

    // Keep the horizontal playhead in view as the media plays.
    const followPlayhead = (t: number) => {
      const sc = scrollRef.current;
      const w = wsRef.current;
      if (!sc || !w) return;
      if (!w.isPlaying()) return;
      const dur = w.getDuration() || 1;
      const total = sc.scrollWidth || 1;
      const x = (t / dur) * total;
      const view = sc.clientWidth;
      if (total <= view) return;
      const margin = 60;
      let target = sc.scrollLeft;
      if (x < sc.scrollLeft + margin) target = Math.max(0, x - margin);
      else if (x > sc.scrollLeft + view - margin)
        target = Math.min(total - view, x - view + margin);
      if (target !== sc.scrollLeft) sc.scrollLeft = target;
    };

    ws.on("timeupdate", (t: number) => followPlayhead(t));
    // Higher-frequency tick for smoother follow.
    ws.on("audioprocess", (t: number) => followPlayhead(t));

    ws.on("ready", () => {
      setReady(true);
      setDuration(ws.getDuration() || 0);
    });

    ws.on("error", (e: any) => console.error("wavesurfer error", e));

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id]);

  // Time labels along the bottom of the waveform — even spacing, ~6 ticks.
  const timeLabels: JSX.Element[] = [];
  if (ready && duration > 0) {
    const count = Math.min(8, Math.max(4, Math.round(totalW / 140)));
    for (let i = 0; i <= count; i++) {
      const t = (i / count) * duration;
      timeLabels.push(<span key={i}>{t.toFixed(2)}s</span>);
    }
  }

  return (
    <div className="space-y-2">
      <div className="wp-panel">
        {/* Scrollable content area: waveform + time labels. */}
        <div ref={scrollRef} className="wp-scroll">
          <div className="wp-content" style={{ width: totalW }}>
            <div
              ref={waveMountRef}
              className="wp-wave"
              style={{ width: totalW, height: DEFAULT_WAVE_H }}
            />
            <div className="wp-times-row">{timeLabels}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
