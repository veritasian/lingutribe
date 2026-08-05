/**
 * Sentence segmentation that mirrors the web client (`src/web/lib/segments.ts`).
 *
 * Two rules:
 *   1. Punctuation break: `. ! ? … 。 ！ ？ …` ends a segment.
 *   2. Pause break:        gap > PAUSE_THRESHOLD_S between word[i].end and
 *                          word[i+1].start ends a segment.
 */
export interface WordEntry {
  text: string;
  start: number;
  end: number;
}

export interface Segment {
  index: number;          // 0-based
  number: number;         // 1-based display
  text: string;           // joined, trimmed
  startTime: number;
  endTime: number;
  wordStartIdx: number;
  wordEndIdx: number;
}

const SENT_END = /[.!?。！？…]+\s*$/;
export const PAUSE_THRESHOLD_S = 0.7;

export function buildSegments(words: WordEntry[]): Segment[] {
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
        text: words.slice(curStart, i + 1).map((x) => x.text).join(" ").trim(),
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
