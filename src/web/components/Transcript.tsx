import { useEffect, useMemo, useRef, useState } from "react";
import { type WordHit } from "../api";
import { BAND_META, rankOf, useCoca, useVisibleBands, type Band } from "../lib/coca";
import { buildSegments, formatSrtTime, type Segment } from "../lib/segments";

interface Token {
  text: string;
  start?: number;
  end?: number;
}

const SENT_END_RE = /[.!?。！？…]+\s*$/;

// Contained, no-jump subtitle scrolling (YouTube/Netflix model): the list is
// its own fixed-height scroll window; we move ONLY that window and only when
// the active SEGMENT changes (never on every spoken word). Each row has a
// fixed height and the active state changes only font-weight/colour, so
// toggling it never shifts layout. We centre the active row via offsetTop +
// scrollTo({behavior:"smooth"}), which is interruptible and never drags the
// page.
function scrollRowToCenter(scroller: HTMLElement, row: HTMLElement) {
  const target = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
  scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

export default function Transcript({
  words,
  transcript,
  onSeek,
  activeIdx = -1,
  activeSegIdx: activeSegIdxProp,
  segments: segmentsProp,
  onSeekSegment,
  onWordClick,
  onAskAi,
  visBands: visBandsProp,
  onToggleBand: onToggleBandProp,
}: {
  words: WordHit[] | null;
  transcript: string;
  onSeek?: (t: number) => void;
  activeIdx?: number;
  /** 0-based index of the active segment (the playing subtitle row). */
  activeSegIdx?: number;
  /** Pre-built segments; if omitted we derive from `words` via punctuation+pause. */
  segments?: Segment[];
  /** Click on a subtitle row. */
  onSeekSegment?: (s: Segment) => void;
  onWordClick?: (data: { text: string; context: string; isWord: boolean; band: Band }) => void;
  // Feature: floating "Ask AI" button on selection.
  onAskAi?: (text: string) => void;
  visBands?: Set<Exclude<Band, null>>;
  onToggleBand?: (b: Exclude<Band, null>, on: boolean) => void;
}) {
  const coca = useCoca();
  const [visBandsLocal, toggleBandLocal] = useVisibleBands();
  const visBands = visBandsProp ?? visBandsLocal;
  const toggleBand = onToggleBandProp ?? toggleBandLocal;
  const [selectedText, setSelectedText] = useState<string | null>(null);
  // Floating "Ask AI" popover anchor (Feature 2).
  const [askRect, setAskRect] = useState<{ x: number; y: number; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tokens (with word-timings when available).
  const tokens: Token[] = useMemo(() => {
    if (words && words.length) {
      return words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    }
    return (transcript || "")
      .split(/(\s+)/)
      .filter((t) => t.length)
      .map((t) => ({ text: t }));
  }, [words, transcript]);

  function bandFor(t: string): Band {
    if (!coca) return null;
    const w = t.toLowerCase().replace(/[^a-z']/g, "");
    if (!w) return null;
    const r = rankOf(coca, w);
    if (r == null) return "above";
    if (r <= 1000) return "1k";
    if (r <= 3000) return "3k";
    if (r <= 5000) return "5k";
    if (r <= 6000) return "6k";
    return "above";
  }

  function bandVisible(t: string): boolean {
    const b = bandFor(t);
    if (!b) return true; // punctuation / non-words always visible
    return visBands.has(b);
  }

  // ── subtitle-mode: build the Segment[] (numbered rows). ──
  // Always derive on the client so changes to segmentation logic don't
  // require the server cache to be invalidated.
  const deriveSegments: Segment[] = useMemo(() => {
    if (segmentsProp && segmentsProp.length) return segmentsProp;
    if (!words || !words.length) return [];
    return buildSegments(words);
  }, [words, segmentsProp]);

  // Auto-derive activeSegIdx if the caller passes only word-level activeIdx.
  const computedSegIdx = useMemo(() => {
    if (activeSegIdxProp != null && activeSegIdxProp >= 0) return activeSegIdxProp;
    if (activeIdx < 0 || !deriveSegments.length) return -1;
    return deriveSegments.findIndex(
      (s) => activeIdx >= s.wordStartIdx && activeIdx <= s.wordEndIdx
    );
  }, [activeSegIdxProp, activeIdx, deriveSegments]);

  // Keep the active subtitle row centred in the transcript's own scroll
  // window as playback advances. This re-runs ONLY when the active SEGMENT
  // changes (computedSegIdx), never on every spoken word — so the window moves
  // just enough to bring the current line to centre, smoothly, instead of
  // jittering. The list itself is the scroll container, so nothing else (the
  // page) moves.
  useEffect(() => {
    const scroller = containerRef.current;
    if (!scroller || computedSegIdx < 0) return;
    const row = scroller.querySelector<HTMLElement>(
      deriveSegments.length > 0
        ? `[data-seg-i="${computedSegIdx}"]`
        : ".subtitle-row.active"
    );
    if (!row) return;
    scrollRowToCenter(scroller, row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedSegIdx, deriveSegments.length]);

  // Scroll the given row into the centre of the window immediately (used on
  // click-to-seek so the jump is instant, not waiting for playback to arrive).
  function scrollToRow(idx: number) {
    const scroller = containerRef.current;
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-seg-i="${idx}"]`);
    if (row) scrollRowToCenter(scroller, row);
  }

  // Capture user text selection (for sentence-level analysis).
  function onMouseUp() {
    if (!onWordClick && !onAskAi) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelectedText(null);
      setAskRect(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) return;
    // Only react to selections inside this transcript.
    if (!containerRef.current?.contains(sel.anchorNode)) return;
    setSelectedText(text);
    // Feature 2: show a floating "Ask AI" button anchored to the selection.
    if (onAskAi) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setAskRect({ x: rect.left, y: rect.bottom + 6, text });
    }
    if (onWordClick) {
      onWordClick({
        text,
        context: text,
        isWord: false,
        band: null,
      });
    }
  }

  function clickToken(t: Token) {
    if (t.start != null && onSeek) onSeek(t.start);
    if (!onWordClick) return;
    // Strip trailing / leading punctuation so the dictionary doesn't see "word," or "(word"
    const clean = t.text.replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, "");
    const i = tokens.indexOf(t);
    const span = tokens
      .slice(Math.max(0, i - 6), i + 7)
      .map((x) => x.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    onWordClick({
      text: clean,
      context: span,
      isWord: true,
      band: bandFor(clean),
    });
  }

  // Render a single token.  Hidden-by-filter words are still shown — just in
  // default text colour (white/normal), no COCA band colouring.
  function renderToken(t: Token, i: number) {
    if (t.text.trim() === "") return <span key={i}>{t.text}</span>;
    const visible = bandVisible(t.text);
    const b = bandFor(t.text);
    // When hidden by filter: show in normal colour, no COCA tint.
    if (!visible) {
      return (
        <span
          key={i}
          data-i={i}
          onClick={() => clickToken(t)}
          className="word"
        >
          {t.text}
        </span>
      );
    }
    return (
      <span
        key={i}
        data-i={i}
        onClick={() => clickToken(t)}
        className={`word ${i === activeIdx ? "active" : ""}`}
        style={
          b && b !== "above" ? { color: BAND_META[b].color } : undefined
        }
        title={b ? `COCA ${b}${t.start != null ? " · click to seek" : ""}` : "click to look up"}
      >
        {t.text}
      </span>
    );
  }

  // Group tokens into sentences by sentence-ending punctuation, OR by
  // pitch/silence gaps (≥PAUSE_THRESHOLD_S seconds between word[i].end and
  // word[i+1].start) so a speaker's natural breath-pauses also become
  // subtitle breaks — same model enjoy uses for its #1 / #2 / … list.
  function groupSentences(): { t: Token; i: number }[][] {
    if (!tokens.length) return [];
    const sents: { t: Token; i: number }[][] = [];
    let cur: { t: Token; i: number }[] = [];
    tokens.forEach((t, i) => {
      cur.push({ t, i });
      const isLast = i === tokens.length - 1;
      let breakHere = isLast;
      if (!isLast && t.end != null && tokens[i + 1].start != null) {
        if (tokens[i + 1].start! - t.end > 0.7) breakHere = true;
      }
      if (SENT_END_RE.test(t.text) && t.text.trim().length) breakHere = true;
      if (breakHere) {
        sents.push(cur);
        cur = [];
      }
    });
    return sents;
  }

  const sentences = useMemo(() => groupSentences(), [tokens]);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Transcript body — always subtitle (one sentence per line), shown
          caption-style: the active line is centered + recoloured and the
          list auto-scrolls up as playback advances (see scroll effect). */}
      <div
        ref={containerRef}
        className="subtitle-list select-text subtitle-caption"
        onMouseUp={onMouseUp}
      >
        {deriveSegments.length === 0 && sentences.length > 0 ? (
          // No timing data (or no words yet) — render the legacy
          // punctuation-only sentence list so user still has something to read.
          sentences.map((s, si) => {
            const start = s.find((x) => x.t.start != null)?.t.start;
            const isActive = s.some((x) => x.i === activeIdx);
            return (
              <div
                key={si}
                data-seg-i={si}
                className={`subtitle-row ${isActive ? "active" : ""}`}
                onClick={() => {
                  if (start != null) {
                    onSeekSegment
                      ? onSeekSegment({
                          index: si,
                          number: si + 1,
                          text: s.map((x) => x.t.text).join(" "),
                          startTime: start,
                          endTime: start,
                          wordStartIdx: s[0].i,
                          wordEndIdx: s[s.length - 1].i,
                        })
                      : onSeek?.(start);
                    scrollToRow(si);
                  }
                }}
              >
                <span className="subtitle-time">
                  {start != null ? formatSrtTime(start) : ""}
                </span>
                <span className="subtitle-text">
                  {s.map((x) => renderToken(x.t, x.i))}
                </span>
              </div>
            );
          })
        ) : (
          deriveSegments.map((seg, si) => (
              <div
                key={seg.index}
                data-seg-i={si}
                className={`subtitle-row ${si === computedSegIdx ? "active" : ""}`}
                onClick={() => {
                  onSeekSegment ? onSeekSegment(seg) : onSeek?.(seg.startTime);
                  scrollToRow(si);
                }}
                title="Click to play from this line"
              >
              <span className="subtitle-time">{formatSrtTime(seg.startTime)} – {formatSrtTime(seg.endTime)}</span>
              <span className="subtitle-text">
                {tokens.slice(seg.wordStartIdx, seg.wordEndIdx + 1).map((t, ti) =>
                  renderToken(t, seg.wordStartIdx + ti)
                )}
              </span>
            </div>
          ))
        )}
      </div>

      {selectedText && (
        <div className="text-[11px] text-muted-foreground mt-2 shrink-0">
          Selection sent to right panel · {selectedText.length} chars
        </div>
      )}

      {/* Floating "Ask AI" popover (Feature 2) */}
      {askRect && (
        <button
          className="fixed z-50 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs shadow-lg hover:opacity-90"
          style={{ left: askRect.x, top: askRect.y }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = askRect.text;
            setAskRect(null);
            window.getSelection()?.removeAllRanges();
            onAskAi?.(t);
          }}
        >
          Ask AI
        </button>
      )}
    </div>
  );
}
