import { useEffect, useMemo, useRef, useState } from "react";
import { type WordHit } from "../api";
import { BAND_META, rankOf, useCoca, useVisibleBands, type Band } from "../lib/coca";
import { segmentText } from "../lib/segment";

interface Token {
  text: string;
  start?: number;
  end?: number;
}

export default function Transcript({
  words,
  transcript,
  onSeek,
  activeIdx = -1,
  scrollIntoView = true,
  onWordClick,
  visBands: visBandsProp,
  onToggleBand: onToggleBandProp,
}: {
  words: WordHit[] | null;
  transcript: string;
  onSeek?: (t: number) => void;
  activeIdx?: number;
  scrollIntoView?: boolean;
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
  // Transcript layout: "flow" (inline paragraph) or "subtitle" (one sentence per line).
  const [view, setView] = useState<"flow" | "subtitle">(() => {
    const v = localStorage.getItem("lingo-transcript-view");
    return v === "subtitle" ? "subtitle" : "flow";
  });
  useEffect(() => {
    localStorage.setItem("lingo-transcript-view", view);
  }, [view]);

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

  // Keep the active word in view (auto-scroll) — matches the A✓ toggle in screenshots.
  useEffect(() => {
    if (!scrollIntoView) return;
    if (activeIdx < 0) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-i="${activeIdx}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx, scrollIntoView]);

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

  // Group tokens into sentences by sentence-ending punctuation. Returns arrays
  // of { token, index } so we can keep global indices (for active highlighting / scroll).
  function groupSentences(): { t: Token; i: number }[][] {
    const sents: { t: Token; i: number }[][] = [];
    let cur: { t: Token; i: number }[] = [];
    tokens.forEach((t, i) => {
      cur.push({ t, i });
      if (/[.!?。！？…]\s*$/.test(t.text) && t.text.trim().length) {
        sents.push(cur);
        cur = [];
      }
    });
    if (cur.length) sents.push(cur);
    return sents;
  }

  const sentences = groupSentences();

  return (
    <div className="space-y-5">
      {/* Layout toggle: Flow (inline) vs Subtitle (one sentence per line) */}
      <div className="flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">Layout</span>
        <div className="flex items-center border rounded-md overflow-hidden">
          <button
            className={`px-2 py-1 ${view === "flow" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            onClick={() => setView("flow")}
            title="Inline paragraph"
          >
            Flow
          </button>
          <button
            className={`px-2 py-1 ${view === "subtitle" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            onClick={() => setView("subtitle")}
            title="One sentence per line"
          >
            Subtitle
          </button>
        </div>
      </div>

      {/* Transcript body */}
      {view === "subtitle" ? (
        <div ref={containerRef} className="select-text" onMouseUp={onMouseUp}>
          {sentences.map((s, si) => {
            const start = s.find((x) => x.t.start != null)?.t.start;
            const isActive = s.some((x) => x.i === activeIdx);
            return (
              <div
                key={si}
                className={`subtitle-line ${isActive ? "active" : ""}`}
                onClick={() => start != null && onSeek?.(start)}
                title={start != null ? "Click to play this sentence" : undefined}
              >
                {s.map((x) => renderToken(x.t, x.i))}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          ref={containerRef}
          className="leading-7 text-[15px] select-text prose max-w-none"
          onMouseUp={onMouseUp}
          onClick={(e) => {
            const sel = window.getSelection();
            if (!sel || !sel.isCollapsed) return;
            const range = document.caretRangeFromPoint(e.clientX, e.clientY);
            if (!range || !containerRef.current?.contains(range.commonAncestorContainer)) return;
            const text = range.startContainer.textContent || "";
            let start = range.startOffset, end = range.endOffset;
            while (start > 0 && /\w/.test(text[start - 1])) start--;
            while (end < text.length && /\w/.test(text[end])) end++;
            const word = text.slice(start, end).trim().replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, "");
            if (word && /^[a-zA-Z']{2,}$/.test(word) && onWordClick) {
              onWordClick({ text: word, context: word, isWord: true, band: bandFor(word) });
            }
          }}
        >
          {(() => {
            const source = transcript || "";
            const paras = segmentText(source);
            return paras.map((para, pi) => (
              <p key={pi} className="mb-5">{para}</p>
            ));
          })()}
        </div>
      )}

      {selectedText && (
        <div className="text-[11px] text-muted-foreground">
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
