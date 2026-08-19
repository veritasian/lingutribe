import { useMemo, useState } from "react";
import { type WordHit } from "../api";
import {
  bandOf,
  lemmatizeWord,
  BAND_META,
  isStopWord,
  type Band,
  type CocaData,
} from "../lib/coca";
import { useWordLists, inList } from "../lib/lists";

interface BandStat { band: Exclude<Band, null>; label: string; unique: number; words: string[] }

/** Human-readable COCA range label shown as the centred band heading in
 *  Statistics (e.g. "0 – 1000"). Kept neutral — no band tint. */
const RANGE_LABEL: Record<Exclude<Band, null>, string> = {
  "1k": "0 – 1000",
  "3k": "1000 – 3000",
  "5k": "3000 – 5000",
  "6k": "5000 – 6000",
  "above": "6000+",
};

export default function VocabProfile({
  coca,
  words,
  transcript,
  onWordClick,
}: { coca: CocaData | null; words: WordHit[]; transcript?: string; onWordClick?: (word: string) => void }) {
  const effectiveWords: WordHit[] = useMemo(() => {
    if (words.length) return words;
    const txt = transcript?.trim();
    if (!txt) return [];
    return txt.split(/\s+/).filter(Boolean).map((text) => ({ text, start: 0, end: 0 }));
  }, [words, transcript]);

  // ── 自定义词表过滤：选中某词表后，统计/分组排除该表内词（只展示非该表内容）──
  const { metas, words: listSets } = useWordLists();
  const [excludeId, setExcludeId] = useState<string>(
    () => localStorage.getItem("lingo-wordlist-filter") || ""
  );
  function setExclude(id: string) {
    setExcludeId(id);
    localStorage.setItem("lingo-wordlist-filter", id);
  }
  const excludeName = metas.find((m) => m.id === excludeId)?.name || "";
  const excludeSet = excludeId ? listSets.get(excludeId) : undefined;

  const { stats, totalTokens, stopTokens, top3kTokens } = useMemo(() => {
    if (!coca || !effectiveWords.length)
      return { stats: [] as BandStat[], totalTokens: 0, stopTokens: 0, top3kTokens: 0 };
    const bandOrder: Exclude<Band, null>[] = ["1k", "3k", "5k", "6k", "above"];
    const map = new Map<Exclude<Band, null>, Set<string>>();
    for (const b of bandOrder) map.set(b, new Set());
    let tot = 0, stop = 0, top3k = 0;

    for (const w of effectiveWords) {
      // 词表过滤：命中选中词表 → 整体跳过（不计入任何统计）
      if (excludeId && inList(w.text, coca, excludeSet)) continue;
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
  }, [coca, effectiveWords, excludeId, excludeSet]);

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
      {/* 自定义词表过滤：默认全部（COCA），选中后只展示非该表内容 */}
      {metas.length > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Word list filter</span>
          <select
            className="select"
            style={{ width: "auto", maxWidth: 220 }}
            value={excludeId}
            onChange={(e) => setExclude(e.target.value)}
            title="排除选中词表内的单词（只展示非该表内容）"
          >
            <option value="">All (COCA)</option>
            {metas.map((m) => (
              <option key={m.id} value={m.id}>
                排除 {m.name}（{m.count}）
              </option>
            ))}
          </select>
          {excludeName && (
            <span className="text-[10px] text-primary/80">
              ↳ 已排除「{excludeName}」词表
            </span>
          )}
        </div>
      )}

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

      {/* Per-band word groups — always visible, no expand/collapse.
          Title centred with a divider; font colour stays neutral. */}
      {stats.map((s) => {
        const range = RANGE_LABEL[s.band];
        const uPct = totalUnique > 0 ? Math.round((s.unique / totalUnique) * 100) : 0;
        return (
          <div key={s.band} className="stat-band">
            <div className="stat-band-head">
              <div className="stat-band-title">{range}</div>
              <div className="stat-divider" />
            </div>
            <div className="stat-band-meta">{s.unique} unique · {uPct}% of vocab</div>
            <div className="stat-words">
              {s.words.map((w) => (
                <button key={w} className="stat-word" onClick={() => onWordClick?.(w)} title={`Look up "${w}"`}>{w}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
