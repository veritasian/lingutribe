// 自定义单词表（四级/六级/考研/雅思…）客户端引擎：
//   - 元数据 + 各表词头集（小写）懒加载并模块级缓存
//   - matchList：先 lemmatize 对齐词头再查表（保证 studied→study 命中）
//   - inList：判断是否命中指定表（供 Layout 过滤排除）
import { useEffect, useState } from "react";
import { api, type WordListMeta } from "../api";
import { lemmatizeWord, type CocaData } from "./coca";

let metasCache: WordListMeta[] | null = null;
let wordsCache: Map<string, Set<string>> | null = null; // listId → 小写词头
let inflight: Promise<{ metas: WordListMeta[]; words: Map<string, Set<string>> }> | null = null;

function load(): Promise<{ metas: WordListMeta[]; words: Map<string, Set<string>> }> {
  if (metasCache && wordsCache) {
    return Promise.resolve({ metas: metasCache, words: wordsCache });
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const metas = await api.listWordLists();
    const words = new Map<string, Set<string>>();
    await Promise.all(
      metas.map(async (m) => {
        try {
          const r = await api.wordListWords(m.id);
          words.set(m.id, new Set(r.words));
        } catch {
          /* 单个词表加载失败不阻塞整体 */
        }
      })
    );
    metasCache = metas;
    wordsCache = words;
    return { metas, words };
  })().catch((e) => {
    inflight = null;
    throw e;
  });
  return inflight;
}

/** 全局词表数据 hook：metas（元数据）+ words（listId → 小写词头集）。 */
export function useWordLists(): {
  metas: WordListMeta[];
  words: Map<string, Set<string>>;
} {
  const [state, setState] = useState<{ metas: WordListMeta[]; words: Map<string, Set<string>> }>(
    () =>
      metasCache && wordsCache
        ? { metas: metasCache, words: wordsCache }
        : { metas: [], words: new Map() }
  );
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && setState(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** word 命中哪个自定义词表（先 lemmatize 对齐词头；按词表注册顺序匹配）。 */
export function matchList(
  word: string,
  coca: CocaData | null,
  words: Map<string, Set<string>>,
  metas: WordListMeta[]
): string | null {
  if (!words.size || !metas.length) return null;
  const raw = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!raw || raw.length < 2) return null;
  const lemma = coca ? lemmatizeWord(coca, raw) : raw;
  for (const m of metas) {
    const set = words.get(m.id);
    if (!set || !set.size) continue;
    if (set.has(raw) || set.has(lemma)) return m.id;
  }
  return null;
}

/** word 是否命中指定词表（Layout 过滤排除用）。 */
export function inList(
  word: string,
  coca: CocaData | null,
  set: Set<string> | undefined
): boolean {
  if (!set || !set.size) return false;
  const raw = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!raw || raw.length < 2) return false;
  if (set.has(raw)) return true;
  const lemma = coca ? lemmatizeWord(coca, raw) : raw;
  return lemma !== raw && set.has(lemma);
}
