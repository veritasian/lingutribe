import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { findSegmentAt, type Segment } from "../lib/segments";

/**
 * Real-time caption display (MDN <track>/WebVTT model).
 *
 * Instead of scrolling a transcript list and re-centring the active row —
 * which produced the up/down "字幕跳动" jitter — this component shows ONLY
 * the cue whose time-range contains the current playback time, and swaps the
 * text in place as time crosses a cue boundary. There is no scrolling, so the
 * box stays put and the displayed line always matches the audio (same timeline
 * as playback). This mirrors how a browser renders the active TextTrack cue on
 * a `cuechange` event.
 */
export default function Caption({
  segments,
  mediaRef,
}: {
  segments: Segment[];
  mediaRef: RefObject<HTMLMediaElement | null>;
}) {
  const [cueIdx, setCueIdx] = useState(-1);
  const cueIdxRef = useRef(-1);

  // Drive the caption straight from the media clock with rAF, recomputing the
  // active cue every frame but only re-rendering when the cue *index* changes.
  // This keeps the switch frame-accurate and decoupled from React state cadence.
  useEffect(() => {
    cueIdxRef.current = -1;
    let raf = 0;
    const loop = () => {
      const media = mediaRef.current;
      if (media) {
        const idx = findSegmentAt(segments, media.currentTime);
        if (idx !== cueIdxRef.current) {
          cueIdxRef.current = idx;
          setCueIdx(idx);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [segments, mediaRef]);

  const seg = cueIdx >= 0 && cueIdx < segments.length ? segments[cueIdx] : null;

  return (
    <div className="caption-bar" aria-live="polite">
      {seg ? (
        <span className="caption-text">{seg.text}</span>
      ) : (
        <span className="caption-idle">Play to show captions</span>
      )}
    </div>
  );
}
