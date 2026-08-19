import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type WordHit, type Highlight, HIGHLIGHT_COLORS } from "../api";
import { BAND_META, rankOf, useCoca, useVisibleBands, type Band } from "../lib/coca";
import {
  buildSegments,
  formatSrtTime,
  mergeSegmentsIntoParagraphs,
  mergeSegmentsIntoParagraphsByCount,
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

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 把一段纯文本按已存高亮逐条包成 <mark>（最长匹配优先，支持跨段重叠）。
function renderHighlighted(text: string, highlights: Highlight[]): React.ReactNode {
  if (!text) return null;
  if (!highlights.length) return text;
  const colorMap = new Map(highlights.map((h) => [h.text, h.color]));
  const bgOf = (key: string) => {
    const c = HIGHLIGHT_COLORS.find((x) => x.key === key);
    return c ? hexToRgba(c.bg, 0.28) : "rgba(234,179,8,0.28)";
  };
  const pieces: { text: string; color?: string }[] = [];
  let rest = text;
  while (rest.length) {
    let bestIdx = -1;
    let bestLen = 0;
    let bestColor: string | null = null;
    for (const [quote, color] of colorMap.entries()) {
      if (!quote) continue;
      const idx = rest.indexOf(quote);
      if (idx !== -1 && quote.length > bestLen) {
        bestIdx = idx;
        bestLen = quote.length;
        bestColor = color;
      }
    }
    if (bestIdx === -1 || bestLen === 0) {
      pieces.push({ text: rest });
      break;
    }
    if (bestIdx > 0) pieces.push({ text: rest.slice(0, bestIdx) });
    pieces.push({ text: rest.slice(bestIdx, bestIdx + bestLen), color: bestColor! });
    rest = rest.slice(bestIdx + bestLen);
  }
  return pieces.map((p, i) =>
    p.color ? (
      <mark
        key={i}
        style={{ background: bgOf(p.color), color: "inherit", borderRadius: 3, padding: "0 1px" }}
      >
        {p.text}
      </mark>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    )
  );
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
  // 划词高亮 + 摘录批注（Content 模式）
  highlights = [],
  onHighlight,
  onNote,
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
  // Floating selection popup (Content mode): Ask / Highlight / Note / Copy.
  onAskAi?: (text: string) => void;
  /** 已存划词高亮（用于 Content 渲染着色） */
  highlights?: Highlight[];
  /** 保存一个划词高亮：onHighlight(text, colorKey) */
  onHighlight?: (text: string, color: string) => void;
  /** 打开右栏 Note，预填该划词：onNote(text) */
  onNote?: (text: string) => void;
  visBands?: Set<Exclude<Band, null>>;
  onToggleBand?: (b: Exclude<Band, null>, on: boolean) => void;
}) {
  const coca = useCoca();
  const [visBandsLocal, toggleBandLocal] = useVisibleBands();
  const visBands = visBandsProp ?? visBandsLocal;
  const toggleBand = onToggleBandProp ?? toggleBandLocal;

  // View mode: "subtitle" = timestamped paragraphs, click-a-word dictionary only;
  // "content" = readable paragraphs, select text → Ask/Highlight/Note/Copy popup.
  const [mode, setMode] = useState<"subtitle" | "content">("subtitle");
  // Floating popup anchor (Content mode only).
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

  // Paragraphs: Subtitle ≈ 20–30s blocks; Content = 3 sentences per block
  // (no timestamps shown in Content).
  const paragraphs: Segment[] = useMemo(
    () =>
      mode === "content"
        ? mergeSegmentsIntoParagraphsByCount(deriveSegments, 3, 3)
        : mergeSegmentsIntoParagraphs(deriveSegments, 25, 15, 35),
    [deriveSegments, mode]
  );

  // Auto-derive active SENTENCE (Subtitle view) from the playing word index.
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
  // floating Ask / Highlight / Note / Copy popup.
  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setAskRect(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) return;
    if (!containerRef.current?.contains(sel.anchorNode)) return;
    if (mode === "content") {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setAskRect({ x: rect.left, y: rect.bottom + 6, text });
    } else {
      setAskRect(null);
    }
  }

  function closePopup() {
    setAskRect(null);
    window.getSelection()?.removeAllRanges();
  }

  function clickToken(t: Token) {
    // 划词（存在选区）时不触发单词单击行为（查词/跳转）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && containerRef.current?.contains(sel.anchorNode)) return;
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
  // ask / highlight / note.
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

  // Content view: no timestamps, 5–10 sentences per paragraph, highlights
  // applied, free text selection.
  function renderContent() {
    return (
      <div ref={containerRef} className="subtitle-list select-text content-body" onMouseUp={onMouseUp}>
        {paragraphs.length === 0
          ? untimedGroups.map((grp, pi) => (
              <div key={pi} data-para-i={pi} className="content-para">
                <span className="content-text">
                  {renderHighlighted(grp.map((x) => x.t.text).join(" "), highlights)}
                </span>
              </div>
            ))
          : paragraphs.map((p, pi) => (
              <div key={p.index} data-para-i={pi} className="content-para">
                <span className="content-text">{renderHighlighted(p.text, highlights)}</span>
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

      {/* Floating selection popup — Content mode only（样式与 Read/news 一致） */}
      {askRect && (
        <div
          className="sel-toolbar"
          style={{ left: Math.min(askRect.x, window.innerWidth - 340), top: askRect.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="sel-toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const t = askRect.text;
              closePopup();
              onAskAi?.(t);
            }}
          >
            Ask AI
          </button>
          <button
            className="sel-toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const t = askRect.text;
              closePopup();
              onHighlight?.(t, "green");
            }}
            title="Highlight"
          >
            Highlight
          </button>
          <button
            className="sel-toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const t = askRect.text;
              closePopup();
              onNote?.(t);
            }}
          >
            Note
          </button>
          <button
            className="sel-toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const t = askRect.text;
              closePopup();
              navigator.clipboard?.writeText(t);
            }}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}
