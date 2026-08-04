import { useMemo } from "react";
import { type WordHit } from "../api";
import {
  bandOf,
  lemmatizeWord,
  BAND_META,
  useVisibleBands,
  isStopWord,
  type Band,
  type CocaData,
} from "../lib/coca";

interface BandStat { band: Exclude<Band, null>; label: string; unique: number; words: string[] }

export default function VocabProfile({
  coca,
  words,
  transcript,
  onWordClick,
}: { coca: CocaData | null; words: WordHit[]; transcript?: string; onWordClick?: (word: string) => void }) {
  const [visBands] = useVisibleBands();

  const effectiveWords: WordHit[] = useMemo(() => {
    if (words.length) return words;
    const txt = transcript?.trim();
    if (!txt) return [];
    return txt.split(/\s+/).filter(Boolean).map((text) => ({ text, start: 0, end: 0 }));
  }, [words, transcript]);

  const { stats, totalTokens, stopTokens, top3kTokens } = useMemo(() => {
    if (!coca || !effectiveWords.length)
      return { stats: [] as BandStat[], totalTokens: 0, stopTokens: 0, top3kTokens: 0 };
    const bandOrder: Exclude<Band, null>[] = ["1k", "3k", "5k", "6k", "above"];
    const map = new Map<Exclude<Band, null>, Set<string>>();
    for (const b of bandOrder) map.set(b, new Set());
    let tot = 0, stop = 0, top3k = 0;

    for (const w of effectiveWords) {
      const raw = w.text.toLowerCase().replace(/[^a-z']/g, "");
      if (!raw || raw.length < 2) continue;
      tot++;
      if (isStopWord(raw)) { stop++; continue; }
      const lemma = lemmatizeWord(coca, raw);
      const b = bandOf(coca, raw) || "above";
      map.get(b)!.add(lemma);
      if (b === "1k" || b === "3k") top3k++;
    }

    const arr: BandStat[] = bandOrder
      .filter((b) => map.get(b)!.size > 0)
      .map((b) => {
        const m = BAND_META[b];
        return {
          band: b,
          label: m.label,
          unique: map.get(b)!.size,
          words: [...map.get(b)!].sort((a, b) => a.localeCompare(b)),
        };
      });
    return { stats: arr, totalTokens: tot, stopTokens: stop, top3kTokens: top3k };
  }, [coca, effectiveWords]);

  const totalUnique = stats.reduce((s, x) => s + x.unique, 0);
  const uniquePct = totalTokens > 0 ? Math.round((totalUnique / totalTokens) * 100) : 0;
  const stopPct = totalTokens > 0 ? Math.round((stopTokens / totalTokens) * 100) : 0;
  // Difficulty: % of text that is either known (top‑3k COCA) or a stop word.
  // Higher % = easier text.
  const knownTokens = top3kTokens + stopTokens;
  const difficulty = totalTokens > 0 ? Math.round((knownTokens / totalTokens) * 100) : 0;

  if (!coca) return <div className="text-sm text-muted-foreground p-4">COCA data not loaded.</div>;
  if (!effectiveWords.length) return <div className="text-sm text-muted-foreground p-4">No text to profile yet.</div>;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span>Total words <b className="text-foreground">{totalTokens}</b></span>
          <span>Unique <b className="text-foreground">{totalUnique}</b></span>
          <span>Unique/total <b className="text-foreground">{uniquePct}%</b></span>
          <span>Stop words <b className="text-foreground">{stopPct}%</b></span>
          <span>Score <b className="text-foreground">{difficulty}%</b></span>
        </div>
        <div className="text-[10px]">
          Score = (top‑3k words + stop words) / total · higher means easier
        </div>
      </div>

      {/* Proportion bar */}
      <div className="flex h-3 rounded-full overflow-hidden bg-secondary">
        {stats.map((s) => {
          const pct = totalUnique > 0 ? (s.unique / totalUnique) * 100 : 0;
          return pct > 0.5 ? (
            <div key={s.band} style={{ width: `${pct}%`, background: BAND_META[s.band].color }}
              title={`${s.label}: ${s.unique} words (${Math.round(pct)}%)`} />
          ) : null;
        })}
      </div>
      <div className="flex gap-3 text-[10px] text-muted-foreground flex-wrap">
        {stats.map((s) => {
          const pct = totalUnique > 0 ? Math.round((s.unique / totalUnique) * 100) : 0;
          return (
            <span key={s.band} className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block"
                style={{ background: BAND_META[s.band].color }} />
              {s.label} {pct}%
            </span>
          );
        })}
      </div>

      {/* Per-band detail cards */}
      {stats.map((s) => {
        const m = BAND_META[s.band];
        const uPct = totalUnique > 0 ? Math.round((s.unique / totalUnique) * 100) : 0;
        const on = visBands.has(s.band);
        return (
          <div key={s.band} className="border rounded-lg p-3"
            style={{
              borderColor: on ? m.color : "hsl(var(--border))",
              background: on ? `rgba(${m.rgb},0.05)` : "hsl(var(--card))",
            }}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm" style={{ color: m.color }}>{m.label}</span>
              <span className="text-[11px] text-muted-foreground">{s.unique} unique · {uPct}% of vocab</span>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground mb-1">
                {s.unique} words ▾
              </summary>
              <div className="flex flex-wrap gap-1 pt-1">
                {s.words.map((w) => (
                  <button key={w} className="px-1.5 py-0.5 rounded text-[11px] cursor-pointer hover:opacity-80"
                    style={{ color: m.color, background: `rgba(${m.rgb},0.12)` }}
                    onClick={() => onWordClick?.(w)} title={`Look up "${w}"`}>{w}</button>
                ))}
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}
