/**
 * Build subtitle segments from word-level STT timestamps.
 *
 * Two-pass segmentation (mirrors enjoy's `wordTimelineToSegmentSentenceTimeline`):
 *   1. Punctuation break:  `. ! ? … 。 ！ ？ …` ends a segment.
 *   2. Pause break:        gap between word[i].end and word[i+1].start
 *                          > PAUSE_THRESHOLD_S ends a segment.
 *
 * Both rules can fire on the same word — punctuation takes priority for that
 * word's segment, and a long pause will start a new segment on the *next* word.
 *
 * The output segment is 1-based for display via `.number`, 0-based for index
 * arithmetic via `.index`. Time is in seconds (matches WordHit.start/end).
 */
import type { WordHit } from "../api";

export interface Segment {
  index: number;          // 0-based — for `[i]` lookups
  number: number;         // 1-based — for "#1 #2 #3 …" display
  text: string;           // joined, trimmed
  startTime: number;      // = words[wordStartIdx].start
  endTime: number;        // = words[wordEndIdx].end
  wordStartIdx: number;   // first word's position in the source array
  wordEndIdx: number;     // last word's position (inclusive)
}

/** Punctuation that ends a sentence in Chinese or English. */
const SENT_END = /[.!?。！？…]+\s*$/;

/**
 * Tunable silence-gap threshold. Lower = more breaks (shorter segments).
 * 0.7s matches typical breath-pause duration and is a comfortable default for
 * English-language listening; UI exposes it for tweaking.
 */
export const PAUSE_THRESHOLD_S = 0.7;

export function buildSegments(words: WordHit[]): Segment[] {
  if (!words || !words.length) return [];

  const segs: Segment[] = [];
  let curStart = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    let breakHere = isLast;
    if (!isLast) {
      const next = words[i + 1];
      // Pause-aware split: a real voice stop (silence gap) ends a sentence.
      if (next.start - w.end > PAUSE_THRESHOLD_S) breakHere = true;
    }
    // Punctuation break — the practical sentence boundary for STT output,
    // which usually carries no silence gaps between words.
    if (SENT_END.test(w.text)) breakHere = true;

    if (breakHere) {
      const firstW = words[curStart];
      const lastW = words[i];
      segs.push({
        index: segs.length,
        number: segs.length + 1,
        text: words
          .slice(curStart, i + 1)
          .map((x) => x.text)
          .join(" ")
          .trim(),
        startTime: firstW.start,
        endTime: lastW.end,
        wordStartIdx: curStart,
        wordEndIdx: i,
      });
      curStart = i + 1;
    }
  }
  return segs;
}

/** "00:12" for < 1h, "01:23:45" otherwise. Subtitle standard. */
export function formatSrtTime(t: number): string {
  if (!isFinite(t) || t < 0) return "00:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Find the segment whose time-range contains `t`. Returns -1 if none. */
export function findSegmentAt(segments: Segment[], t: number): number {
  if (!segments.length) return -1;
  // Linear scan is fine for typical transcripts (<2k segments).
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (t >= s.startTime && t < s.endTime) return i;
  }
  // If past the last segment's end, snap to last segment.
  if (t >= segments[segments.length - 1].endTime) return segments.length - 1;
  return -1;
}
