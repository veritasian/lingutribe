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
      // BUT only break on the pause if the accumulated segment is already
      // long enough — otherwise short sentences get fragmented into a flurry
      // of pause-broken pieces that overlap with the full sentence, which
      // duplicates rows in the subtitle list and triplicates content. A 15s
      // floor means pauses only break *long* monologues, not ordinary
      // sentences with natural mid-sentence breaths.
      const accDur = w.end - words[curStart].start;
      if (next.start - w.end > PAUSE_THRESHOLD_S && accDur >= 15) breakHere = true;
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

/**
 * Merge sentence-level segments into reader-friendly paragraphs of roughly
 * `targetSec` seconds (clamped to [minSec, maxSec]). Used by the Transcript's
 * "Subtitle" view so each block shows one start–end time range instead of a
 * per-sentence flicker. Breaks prefer a natural sentence boundary near the
 * target, and hard-cap at `maxSec` so a single long utterance never balloons.
 */
export function mergeSegmentsIntoParagraphs(
  segs: Segment[],
  targetSec = 25,
  minSec = 15,
  maxSec = 35
): Segment[] {
  if (!segs.length) return [];
  const out: Segment[] = [];
  let cur: Segment[] = [];
  let paraStart = segs[0].startTime;

  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const last = cur[cur.length - 1];
    out.push({
      index: out.length,
      number: out.length + 1,
      text: cur.map((s) => s.text).join(" "),
      startTime: first.startTime,
      endTime: last.endTime,
      wordStartIdx: first.wordStartIdx,
      wordEndIdx: last.wordEndIdx,
    });
    cur = [];
  };

  for (const s of segs) {
    if (!cur.length) {
      cur = [s];
      paraStart = s.startTime;
      continue;
    }
    const dur = s.endTime - paraStart;
    // Start a new paragraph BEFORE this segment if the current one is already
    // long enough and would overshoot the target by adding it.
    if (dur >= minSec && dur + (s.endTime - s.startTime) > targetSec) {
      flush();
      cur = [s];
      paraStart = s.startTime;
      continue;
    }
    cur.push(s);
    // Hard cap — flush even mid-sentence if a single paragraph gets too long.
    if (s.endTime - paraStart >= maxSec) flush();
  }
  flush();
  return out;
}

/**
 * Merge sentence-level segments into reader-friendly paragraphs by SENTENCE
 * COUNT (5–10 per paragraph), ignoring timestamps. Used by the Transcript's
 * "Content" view: no timestamps shown, paragraphs switch every 5–10 sentences.
 */
export function mergeSegmentsIntoParagraphsByCount(
  segs: Segment[],
  minSentences = 5,
  maxSentences = 10
): Segment[] {
  if (!segs.length) return [];
  const out: Segment[] = [];
  let cur: Segment[] = [];

  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const last = cur[cur.length - 1];
    out.push({
      index: out.length,
      number: out.length + 1,
      text: cur.map((s) => s.text).join(" "),
      startTime: first.startTime,
      endTime: last.endTime,
      wordStartIdx: first.wordStartIdx,
      wordEndIdx: last.wordEndIdx,
    });
    cur = [];
  };

  for (const s of segs) {
    if (!cur.length) {
      cur = [s];
      continue;
    }
    // 已积累 ≥ min 句且加上本句会超过 max 句 → 另起一段
    if (cur.length >= minSentences && cur.length + 1 > maxSentences) {
      flush();
      cur = [s];
      continue;
    }
    cur.push(s);
  }
  flush();
  return out;
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

/**
 * Collapse consecutive repeated word-runs produced by STT engines that
 * sometimes loop during silence or non-speech tags like
 * "[music]". A real source artifact looks like this (verbatim, in the stored
 * `words`/`transcript`):
 *
 *   "…immense guilt towards I have this like immense guilt towards I have
 *    this like immense guilt towards past how much [music] I wasted money.
 *    past how much [music] I wasted money. past how much [music] I wasted
 *    money. And I…"
 *
 * Each immediate repetition is reduced to a single copy. The check is purely
 * structural (identical consecutive word sequences), so it never touches
 * legitimate prose that isn't an exact repeat. This is what makes the displayed
 * subtitle match the clean "native" caption the user expects.
 */
export function collapseRepetition(words: WordHit[]): WordHit[] {
  if (!words || words.length < 4) return words ?? [];
  const n = words.length;
  const out: WordHit[] = [];
  let i = 0;
  const maxL = Math.min(40, Math.floor(n / 2));
  while (i < n) {
    let collapsed = false;
    for (let L = 2; L <= maxL; L++) {
      if (i + L > n) break;
      // Count how many consecutive copies of the L-word block [i, i+L) repeat.
      let reps = 1;
      let match = true;
      while (i + reps * L + L <= n) {
        let blockSame = true;
        for (let t = 0; t < L; t++) {
          if (words[i + reps * L + t].text !== words[i + (reps - 1) * L + t].text) {
            blockSame = false;
            break;
          }
        }
        if (blockSame) reps++;
        else {
          match = false;
          break;
        }
      }
      if (reps >= 2) {
        for (let t = 0; t < L; t++) out.push(words[i + t]);
        i += reps * L;
        collapsed = true;
        break;
      }
      // (match === false just means this length L didn't repeat — keep trying
      // other lengths; only break the L-loop once we actually collapse.)
    }
    if (!collapsed) {
      out.push(words[i]);
      i++;
    }
  }
  return out;
}

/**
 * Subtitle (字幕) segmentation tuned for Whisper STT word timelines.
 *
 * Rules (per product spec):
 *   1. Max speech duration: a cue is capped at MAX_SPEECH_DUR_S of speech span
 *      (8–10s) — long utterances are split so each line stays readable.
 *   2. Merge short cues: any cue whose speech span is below MIN_SPEECH_DUR_S
 *      (4000ms) is folded into the NEXT cue — the short fragment becomes the
 *      START (opening words) of the next subtitle segment, rather than a
 *      trailing tail on the previous one. Falls back to the previous cue only
 *      when the next is already near the max duration.
 *   3. Silence splitting: a silence gap longer than SILENCE_SPLIT_S (9000ms)
 *      between two words forces a new cue; shorter gaps are NOT breaks and are
 *      absorbed into the surrounding cue (rule 2 then merges tiny fragments).
 *
 * Unlike the old fixed-length chunker, this respects natural pauses, so the
 * caption lines line up with how a person actually paused while speaking.
 */
export const MAX_SPEECH_DUR_S = 10; // rule 1: 8–10s cap
export const MIN_SPEECH_DUR_S = 4; // rule 2: 4000ms
export const SILENCE_SPLIT_S = 9; // rule 3: 9000ms

export function buildSubtitles(
  words: WordHit[],
  opts?: {
    maxSpeechDur?: number;
    minSpeechDur?: number;
    silenceSplit?: number;
  }
): Segment[] {
  const maxSpeechDur = opts?.maxSpeechDur ?? MAX_SPEECH_DUR_S;
  const minSpeechDur = opts?.minSpeechDur ?? MIN_SPEECH_DUR_S;
  const silenceSplit = opts?.silenceSplit ?? SILENCE_SPLIT_S;
  if (!words || !words.length) return [];

  // Pass 1 — greedy split on a long silence or the max speech duration.
  const raw: Segment[] = [];
  let curStart = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isLast = i === words.length - 1;
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    const span = w.end - words[curStart].start;

    let endHere = isLast;
    if (!isLast) {
      if (gap > silenceSplit) endHere = true; // rule 3: long silence → new cue
      else if (span >= maxSpeechDur) endHere = true; // rule 1: cap speech span
      // gaps ≤ silenceSplit are intentionally NOT breaks → merged into the cue
    }
    if (endHere) {
      raw.push(makeSeg(words, curStart, i, raw.length));
      curStart = i + 1;
    }
  }

  // Pass 2 — merge cues shorter than minSpeechDur into an adjacent cue.
  return renumber(mergeShortCues(raw, minSpeechDur, maxSpeechDur));
}

function makeSeg(
  words: WordHit[],
  start: number,
  end: number,
  index: number
): Segment {
  const slice = words.slice(start, end + 1);
  return {
    index,
    number: index + 1,
    text: slice.map((w) => w.text).join(" ").trim(),
    startTime: slice[0].start,
    endTime: slice[slice.length - 1].end,
    wordStartIdx: start,
    wordEndIdx: end,
  };
}

function joinSeg(a: Segment, b: Segment): Segment {
  return {
    index: a.index,
    number: a.number,
    text: `${a.text} ${b.text}`.trim(),
    startTime: a.startTime,
    endTime: b.endTime,
    wordStartIdx: a.wordStartIdx,
    wordEndIdx: b.wordEndIdx,
  };
}

function mergeShortCues(
  segs: Segment[],
  minDur: number,
  maxDur: number
): Segment[] {
  if (segs.length <= 1) return segs;
  const out: Segment[] = [];
  let i = 0;
  while (i < segs.length) {
    const cur = segs[i];
    const curDur = cur.endTime - cur.startTime;
    if (curDur >= minDur || i === segs.length - 1) {
      out.push(cur);
      i++;
      continue;
    }
    const prev = out[out.length - 1];
    const next = segs[i + 1];
    // Prefer merging the short cue INTO the NEXT cue so it becomes the START
    // (opening words) of that next segment — the natural reading for a brief
    // lead-in after a split. Fall back to the previous cue only when the next
    // is already near the max duration.
    if (next.endTime - cur.startTime <= maxDur) {
      // Fold cur into segs[i+1] as its opening; skip past cur.
      segs[i + 1] = joinSeg(cur, next);
      i++;
    } else if (prev && cur.endTime - prev.startTime <= maxDur) {
      out[out.length - 1] = joinSeg(prev, cur);
      i++;
    } else {
      // Neither neighbour fits — keep as-is (rare; slight min violation).
      out.push(cur);
      i++;
    }
  }
  return out;
}

function renumber(segs: Segment[]): Segment[] {
  return segs.map((s, i) => ({ ...s, index: i, number: i + 1 }));
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
