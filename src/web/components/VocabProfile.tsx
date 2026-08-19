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
import { useWordLists } from "../lib/lists";

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

  // ── 自定义词表视图：选中某词表后，在全文 COCA 统计之上展示该表词汇的
  //    词频分布（20+/10+/5+/2+/1+，按在本文出现次数分层）──
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

  // COCA 统计基于全文（不再排除所选词表内的词）
  const { stats, totalTokens, stopTokens, top3kTokens, freq } = useMemo(() => {
    if (!coca || !effectiveWords.length)
      return {
        stats: [] as BandStat[],
        totalTokens: 0,
        stopTokens: 0,
        top3kTokens: 0,
        freq: new Map<string, number>(),
      };
    const bandOrder: Exclude<Band, null>[] = ["1k", "3k", "5k", "6k", "above"];
    const map = new Map<Exclude<Band, null>, Set<string>>();
    for (const b of bandOrder) map.set(b, new Set());
    let tot = 0, stop = 0, top3k = 0;
    const freq = new Map<string, number>();

    for (const w of effectiveWords) {
      const raw = w.text.toLowerCase().replace(/[^a-z']/g, "");
      if (!raw || raw.length < 2) continue;
      // 词频统计（按 lemma 聚合，全文范围：给选中词表的词频分层视图用）
      const lemmaAll = lemmatizeWord(coca, raw);
      freq.set(lemmaAll, (freq.get(lemmaAll) || 0) + 1);
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
    return { stats: arr, totalTokens: tot, stopTokens: stop, top3kTokens: top3k, freq };
  }, [coca, effectiveWords]);

  // 选中词表 → 「词频分布」分层：20+ / 10+ / 5+ / 2+ / 1+，层内按字母排列
  const listTiers = useMemo(() => {
    if (!excludeId || !excludeSet || !excludeName || !freq.size) return null;
    const buckets: [string, number][] = [
      ["20+", 20],
      ["10+", 10],
      ["5+", 5],
      ["2+", 2],
      ["1+", 1],
    ];
    const tiers: { label: string; words: string[] }[] = [];
    for (const [label, min] of buckets) {
      const words = [...freq.entries()]
        .filter(([w, n]) => n >= min && excludeSet.has(w))
        .map(([w]) => w)
        .sort((a, b) => a.localeCompare(b));
      if (words.length) tiers.push({ label, words });
    }
    return tiers.length ? { name: excludeName, tiers } : null;
  }, [excludeId, excludeSet, excludeName, freq]);

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
            title="选中词表后，展示该表词汇在本文的词频分布（COCA 统计保持全文范围）"
          >
            <option value="">All (COCA)</option>
            {metas.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} 词表（{m.count}）
              </option>
            ))}
          </select>
          {excludeName && (
            <span className="text-[10px] text-primary/80">
              ↳ 查看「{excludeName}」在本文的词频分布
            </span>
          )}
        </div>
      )}

      {/* 选中词表 → 词频分布（20+/10+/5+/2+/1+，层内按字母排列，左对齐） */}
      {listTiers && (
        <div className="rounded-lg border p-3 space-y-2.5 bg-muted/20 mb-6">
          <div className="text-xs font-medium">
            「{listTiers.name}」词频分布
            <span className="text-[10px] text-muted-foreground font-normal ml-2">
              本篇出现次数分层 · 层内按字母排序
            </span>
          </div>
          {listTiers.tiers.map((t) => (
            <div key={t.label} className="flex items-start gap-2">
              <span className="stat-band-title shrink-0" style={{ marginBottom: 0, fontSize: 12 }}>
                {t.label}
              </span>
              <div className="stat-words">
                {t.words.map((w) => (
                  <button
                    key={w}
                    className="stat-word"
                    onClick={() => onWordClick?.(w)}
                    title={`Look up "${w}"`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          ))}
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
