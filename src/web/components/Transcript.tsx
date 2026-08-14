import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type WordHit } from "../api";
import { BAND_META, rankOf, useCoca, useVisibleBands, type Band } from "../lib/coca";
import {
  buildSegments,
  formatSrtTime,
  mergeSegmentsIntoParagraphs,
  type Segment,
} from "../lib/segments";

interface Token {
  text: string;
  start?: number;
  end?: number;
}

const SENT_END_RE = /[.!?。！？…]+\s*$/;

// Contained, no-jump subtitle scrolling (YouTube/Netflix model): the list is
// its own fixed-height scroll window; we move ONLY that window and only when
// the active PARAGRAPH changes (never on every spoken word). Each row has a
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
  // Feature: floating "Ask AI" / "Copy" popup on text selection (Content mode).
  onAskAi?: (text: string) => void;
  visBands?: Set<Exclude<Band, null>>;
  onToggleBand?: (b: Exclude<Band, null>, on: boolean) => void;
}) {
  const coca = useCoca();
  const [visBandsLocal, toggleBandLocal] = useVisibleBands();
  const visBands = visBandsProp ?? visBandsLocal;
  const toggleBand = onToggleBandProp ?? toggleBandLocal;

  // View mode: "subtitle" = timestamped paragraphs, click-a-word dictionary only;
  // "content" = readable paragraphs, select text → Ask/Copy popup.
  const [mode, setMode] = useState<"subtitle" | "content">("subtitle");
  // Floating "Ask / Copy" popover anchor (Content mode only).
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

  // Sentence-level segments (numbered rows), derived on the client.
  const deriveSegments: Segment[] = useMemo(() => {
    if (segmentsProp && segmentsProp.length) return segmentsProp;
    if (!words || !words.length) return [];
    return buildSegments(words);
  }, [words, segmentsProp]);

  // Paragraphs (~20–30s) for both Subtitle and Content display.
  const paragraphs: Segment[] = useMemo(
    () => mergeSegmentsIntoParagraphs(deriveSegments, 25, 15, 35),
    [deriveSegments]
  );

  // Auto-derive active PARAGRAPH (Content view) from the playing word index.
  const activeParaIdx = useMemo(() => {
    if (activeIdx >= 0) {
      const f = paragraphs.findIndex(
        (p) => activeIdx >= p.wordStartIdx && activeIdx <= p.wordEndIdx
      );
      if (f >= 0) return f;
    }
    if (activeSegIdxProp != null && activeSegIdxProp >= 0 && paragraphs[activeSegIdxProp]) {
      return activeSegIdxProp;
    }
    return -1;
  }, [activeIdx, activeSegIdxProp, paragraphs]);

  // Auto-derive active SENTENCE (Subtitle view) from the playing word index.
  // Subtitle mode keeps the original per-sentence rows, so we track those.
  const activeSentIdx = useMemo(() => {
    if (activeIdx >= 0) {
      const f = deriveSegments.findIndex(
        (s) => activeIdx >= s.wordStartIdx && activeIdx <= s.wordEndIdx
      );
      if (f >= 0) return f;
    }
    if (activeSegIdxProp != null && activeSegIdxProp >= 0 && deriveSegments[activeSegIdxProp]) {
      return activeSegIdxProp;
    }
    return -1;
  }, [activeIdx, activeSegIdxProp, deriveSegments]);

  // Keep the active SENTENCE centred in the transcript's own scroll window as
  // playback advances — but ONLY in Subtitle mode. Content mode is a reading
  // view and must not yank the page around while the user is reading.
  useEffect(() => {
    const scroller = containerRef.current;
    if (!scroller || mode !== "subtitle" || activeSentIdx < 0) return;
    const row = scroller.querySelector<HTMLElement>(`[data-seg-i="${activeSentIdx}"]`);
    if (!row) return;
    scrollRowToCenter(scroller, row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeSentIdx, deriveSegments.length]);

  // Scroll a row into the centre of the window immediately (used on
  // click-to-seek so the jump is instant, not waiting for playback).
  function scrollToRow(idx: number, attr: "seg" | "para") {
    const scroller = containerRef.current;
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-${attr}-i="${idx}"]`);
    if (row) scrollRowToCenter(scroller, row);
  }

  // Capture user text selection. In Subtitle mode selection is ignored (no
  // menu) — only word-click dictionary works. In Content mode it opens the
  // floating Ask / Copy popup.
  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setAskRect(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) return;
    if (!containerRef.current?.contains(sel.anchorNode)) return;
    if (mode === "content" && onAskAi) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setAskRect({ x: rect.left, y: rect.bottom + 6, text });
    } else {
      setAskRect(null);
    }
  }

  function clickToken(t: Token) {
    if (t.start != null && onSeek) onSeek(t.start);
    if (!onWordClick) return;
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

  // Plain-text render (Content view): no per-word click, no COCA colouring —
  // just the literal text, so it reads as prose and you can select freely to
  // ask. The dictionary-hyperlink behaviour is Subtitle-only.
  function renderPlain(t: Token, i: number) {
    return <span key={i}>{t.text}</span>;
  }

  // Render a single token. Hidden-by-filter words are still shown — just in
  // default text colour (white/normal), no COCA band colouring.
  function renderToken(t: Token, i: number) {
    if (t.text.trim() === "") return <span key={i}>{t.text}</span>;
    const visible = bandVisible(t.text);
    const b = bandFor(t.text);
    const cls = `word ${i === activeIdx ? "active" : ""}`;
    if (!visible) {
      return (
        <span key={i} data-i={i} onClick={() => clickToken(t)} className="word">
          {t.text}
        </span>
      );
    }
    return (
      <span
        key={i}
        data-i={i}
        onClick={() => clickToken(t)}
        className={cls}
        style={b && b !== "above" ? { color: BAND_META[b].color } : undefined}
        title={b ? `COCA ${b}${t.start != null ? " · click to seek" : ""}` : "click to look up"}
      >
        {t.text}
      </span>
    );
  }

  // Group tokens into sentences by sentence-ending punctuation, OR by
  // pitch/silence gaps (≥0.7s) — same model used for the subtitle segments.
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

  // Untimed fallback (no word timings): one sentence per row.
  const untimedGroups = useMemo(() => {
    if (paragraphs.length) return [] as { t: Token; i: number }[][];
    return sentences;
  }, [paragraphs.length, sentences]);

  // Subtitle view = ORIGINAL per-sentence subtitle rows: time range + word
  // colouring, click a word to look it up. Selection is disabled (select-none)
  // so no Ask/Copy menu ever appears here.
  function renderSubtitle() {
    return (
      <div ref={containerRef} className="subtitle-list select-none" onMouseUp={onMouseUp}>
        {deriveSegments.length === 0
          ? untimedGroups.map((grp, si) => {
              const start = grp.find((x) => x.t.start != null)?.t.start;
              return (
                <div
                  key={si}
                  data-seg-i={si}
                  className="subtitle-row"
                  onClick={() => {
                    if (start != null) {
                      onSeek?.(start);
                      scrollToRow(si, "seg");
                    }
                  }}
                >
                  <span className="subtitle-time">
                    {start != null ? formatSrtTime(start) : ""}
                  </span>
                  <span className="subtitle-text">
                    {grp.map((x) => renderToken(x.t, x.i))}
                  </span>
                </div>
              );
            })
          : deriveSegments.map((s, si) => (
              <div
                key={s.index}
                data-seg-i={si}
                className={`subtitle-row ${si === activeSentIdx ? "active" : ""}`}
                onClick={() => {
                  onSeekSegment ? onSeekSegment(s) : onSeek?.(s.startTime);
                  scrollToRow(si, "seg");
                }}
                title="Click to play from this line"
              >
                <span className="subtitle-time">
                  {formatSrtTime(s.startTime)} – {formatSrtTime(s.endTime)}
                </span>
                <span className="subtitle-text">
                  {tokens.slice(s.wordStartIdx, s.wordEndIdx + 1).map((t, ti) => {
                    const i = s.wordStartIdx + ti;
                    return (
                      <Fragment key={i}>
                        {ti > 0 && " "}
                        {renderToken(t, i)}
                      </Fragment>
                    );
                  })}
                </span>
              </div>
            ))}
      </div>
    );
  }

  function renderContent() {
    return (
      <div ref={containerRef} className="subtitle-list select-text content-body" onMouseUp={onMouseUp}>
        {paragraphs.length === 0
          ? untimedGroups.map((grp, pi) => {
              const start = grp.find((x) => x.t.start != null)?.t.start;
              return (
                <div key={pi} data-para-i={pi} className="content-para">
                  {start != null && <span className="content-time">{formatSrtTime(start)}</span>}
                  <span className="content-text">
                    {grp.map((x) => renderPlain(x.t, x.i))}
                  </span>
                </div>
              );
            })
          : paragraphs.map((p, pi) => (
              <div key={p.index} data-para-i={pi} className="content-para">
                <span className="content-time">{formatSrtTime(p.startTime)}</span>
                  <span className="content-text">{p.text}</span>
              </div>
            ))}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Subtitle / Content switch */}
      <div className="transcript-toolbar shrink-0 flex items-center gap-2 px-1 pb-2">
        <div className="mode-toggle" role="tablist" aria-label="Transcript view">
          <button
            role="tab"
            aria-selected={mode === "subtitle"}
            className={mode === "subtitle" ? "active" : ""}
            onClick={() => setMode("subtitle")}
          >
            Subtitle
          </button>
          <button
            role="tab"
            aria-selected={mode === "content"}
            className={mode === "content" ? "active" : ""}
            onClick={() => setMode("content")}
          >
            Content
          </button>
        </div>
      </div>

      {mode === "subtitle" ? renderSubtitle() : renderContent()}

      {/* Floating "Ask / Copy" popup — Content mode only */}
      {askRect && (
        <div
          className="ask-popup fixed z-50 flex items-center gap-1"
          style={{ left: askRect.x, top: askRect.y }}
        >
          <button
            className="ask-popup-btn"
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
          <button
            className="ask-popup-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigator.clipboard?.writeText(askRect.text);
              setAskRect(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
