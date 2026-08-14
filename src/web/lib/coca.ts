// Load the COCA frequency bands once at app start and provide
// helpers: rank lookup, unique-word list, band→color mapping.
import { useEffect, useState, useMemo } from "react";

export type Band = "1k" | "3k" | "5k" | "6k" | "above" | null;

export interface CocaData {
  ranks: Record<string, number>;
  band_thresholds: Record<string, number>;
}

let cache: CocaData | null = null;
let inflight: Promise<CocaData> | null = null;

function load(): Promise<CocaData> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/coca/bands")
    .then((r) => {
      if (!r.ok) throw new Error("COCA data unavailable");
      return r.json() as Promise<CocaData>;
    })
    .then((d) => {
      cache = d;
      return d;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });
  return inflight;
}

export function useCoca() {
  const [data, setData] = useState<CocaData | null>(cache);
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

export function bandOf(data: CocaData | null, word: string): Band {
  if (!data) return null;
  const r = rankOf(data, word);
  if (r == null) return "above";
  if (r <= 1000) return "1k";
  if (r <= 3000) return "3k";
  if (r <= 5000) return "5k";
  if (r <= 6000) return "6k";
  return "above";
}

/**
 * Contraction → lemma map.  Mapped to the most common headword in COCA
 * so that can't → can, don't → do, etc.
 */
const CONTRACTION_MAP: Record<string, string> = {
  // negation
  "can't": "can", "cannot": "can",
  "don't": "do", "doesn't": "do", "didn't": "do",
  "won't": "will", "wouldn't": "would",
  "shouldn't": "should", "couldn't": "could",
  "isn't": "be", "aren't": "be", "ain't": "be",
  "wasn't": "be", "weren't": "be",
  "haven't": "have", "hasn't": "have", "hadn't": "have",
  "mustn't": "must", "needn't": "need",
  "mightn't": "might",
  // to-be
  "i'm": "be", "you're": "be", "we're": "be", "they're": "be",
  "he's": "be", "she's": "be", "it's": "be",
  // possessives
  "'s": "", "s'": "",
  // would / had ('d)
  "i'd": "would", "you'd": "would", "we'd": "would", "they'd": "would",
  "he'd": "would", "she'd": "would", "it'd": "would", "'d": "would",
  // will ('ll)
  "i'll": "will", "you'll": "will", "we'll": "will", "they'll": "will",
  "he'll": "will", "she'll": "will", "it'll": "will", "'ll": "will",
  // have ('ve)
  "i've": "have", "you've": "have", "we've": "have", "they've": "have",
  "he've": "have", "she've": "have", "'ve": "have",
  // other
  "let's": "let", "that's": "that", "what's": "what",
  "who's": "who", "there's": "there", "here's": "here",
  "gonna": "go", "wanna": "want", "gotta": "get",
  "d'you": "do", "dunno": "know", "gimme": "give",
  "lemme": "let", "kinda": "kind", "sorta": "sort",
};

/**
 * Irregular inflections that no suffix rule can derive.  Maps a surface form
 * directly to its COCA headword (lemma).  Only the high-frequency ones that
 * actually appear in spoken transcripts are listed — this is an exception list,
 * not a full dictionary.  Keys are lowercase; values are headwords present in
 * the COCA bands file.
 */
const IRREGULAR: Record<string, string> = {
  // irregular noun plurals
  children: "child", men: "man", women: "woman", feet: "foot",
  teeth: "tooth", mice: "mouse", geese: "goose", oxen: "ox",
  // strong-verb past / past-participle → base
  went: "go", got: "get", took: "take", came: "come", gave: "give",
  made: "make", said: "say", saw: "see", knew: "know", thought: "think",
  found: "find", brought: "bring", bought: "buy", caught: "catch",
  taught: "teach", slept: "sleep", kept: "keep", left: "leave", lost: "lose",
  held: "hold", told: "tell", felt: "feel", met: "meet", led: "lead",
  paid: "pay", laid: "lay", meant: "mean", built: "build", sent: "send",
  spent: "spend", lent: "lend", dealt: "deal", heard: "hear", shook: "shake",
  broke: "break", spoke: "speak", wrote: "write", ate: "eat", drove: "drive",
  chose: "choose", froze: "freeze", stole: "steal", drew: "draw", showed: "show",
  grew: "grow", threw: "throw", blew: "blow", flew: "fly", wore: "wear",
  bore: "bear", tore: "tear", rode: "ride", hid: "hide", bit: "bite",
  lit: "light", sank: "sink", swam: "swim", ran: "run",
  // irregular adjectives / adverbs
  better: "good", best: "good", worse: "bad", worst: "bad",
  farther: "far", further: "far",
};

/** English function words: pronouns, articles, auxiliaries, prepositions,
 *  conjunctions, numbers, etc.  These are so common they distort vocabulary
 *  profiling — excluded from COCA value calculations. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // pronouns
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ours", "ourselves",
  "they", "them", "their", "theirs", "themselves",
  "this", "that", "these", "those",
  "who", "whom", "whose", "which", "what",
  // articles
  "a", "an", "the",
  // be
  "am", "is", "are", "was", "were", "be", "been", "being",
  // have
  "have", "has", "had", "having",
  // do
  "do", "does", "did",
  // modals
  "will", "would", "shall", "should",
  "can", "could", "may", "might", "must",
  // prepositions
  "of", "in", "to", "for", "with", "on", "at", "from",
  "by", "about", "as", "into", "through", "during",
  "before", "after", "above", "below", "between",
  "under", "over", "up", "down", "out", "off",
  // conjunctions
  "and", "but", "or", "nor", "so", "yet",
  "because", "if", "than", "then", "while",
  "when", "where", "how", "though", "although",
  // other function words
  "not", "no", "yes", "very", "too", "also",
  "just", "now", "here", "there",
  "all", "some", "any", "each", "every",
  "both", "few", "more", "most", "other", "such",
  "only", "own", "same", "one", "two", "three",
  // numbers (spelled)
  "four", "five", "six", "seven", "eight", "nine", "ten",
  "hundred", "thousand", "million", "billion",
  "first", "second", "third",
  // discourse
  "well", "yeah", "ok", "okay", "oh", "uh", "um",
  "ah", "hey", "hi", "hello", "like", "really",
  // empty
  "",
]);

/** Clean a surface token: trim punctuation, expand contractions,
 *  strip possessive 's, lowercase.  Returns the raw-norm form (still
 *  a surface word — suffix stripping happens in rankOf). */
function normalizeToken(w: string): string | null {
  let t = w.toLowerCase()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/['']/g, "'")
    .replace(/`/g, "'")
    .trim();
  // strip trailing possessive "'s" / "s'"
  t = t.replace(/'s$/, "").replace(/^s'$/, "").replace(/s'$/, "");
  if (!t || /^\d+$/.test(t)) return null;
  // check contraction map
  if (CONTRACTION_MAP[t] != null) return CONTRACTION_MAP[t];
  return t;
}

/** Return true when a word should be excluded from vocabulary profiling
 *  because it is a function word / stop word / pronoun / number. */
export function isStopWord(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w || /^\d+$/.test(w)) return true;
  // check direct, then try normalizing contractions
  if (STOP_WORDS.has(w)) return true;
  const norm = CONTRACTION_MAP[w];
  return !!norm && STOP_WORDS.has(norm);
}

/**
 * Look up a word's COCA rank. The list is **headword forms** (lemmas).
 * We first expand contractions, then try suffix/prefix rules.
 */
export function rankOf(data: CocaData, word: string, depth = 0): number | null {
  if (!data || depth > 2) return null;
  const normalized = normalizeToken(word);
  // Try the normalized form first (e.g. can't → can), then fall through
  // to the suffix-stripping chain on the original.
  if (normalized && data.ranks[normalized] != null) return data.ranks[normalized];
  const w = normalized || word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return null;
  if (data.ranks[w] != null) return data.ranks[w];

  // Irregular inflections (no rule can derive these) — explicit exceptions.
  // Checked before the length guard so short forms (men, ran, ate, saw…) resolve.
  const irr = IRREGULAR[w];
  if (irr != null && data.ranks[irr] != null) return data.ranks[irr];

  if (w.length < 4) return null;

  // ----- Phase 1: derivational prefix strip -----
  // im-/in-/ir-/un-/dis-/re-/pre-/mis-/over-/under-
  const PREFIXES = ["im", "in", "ir", "un", "non", "dis", "re", "pre", "mis", "over", "under"];
  for (const p of PREFIXES) {
    if (w.startsWith(p) && w.length > p.length + 3) {
      const r = rankOf(data, w.slice(p.length), depth + 1);
      if (r != null) return r;
    }
  }

  // ----- Phase 2: suffix REPLACEMENT (more specific first) -----
  const REPLACEMENTS: [string, string][] = [
    ["ication", "y"],     // identification → identify
    ["ically",  "y"],     // historically → history
    ["ical",    "y"],     // historical → history
    ["ities",   "ity"],   // cities → city
    ["iest",    "y"],     // happiest → happy
    ["ier",     "y"],     // happier → happy
    ["ies",     "y"],     // flies → fly, carries → carry
    ["ied",     "y"],     // cried → cry, studied → study
    ["ation",   "ate"],   // creation → create
    ["tion",    "te"],    // completion → complete
    ["ian",     "y"],     // historian → history
    ["iness",   "y"],     // happiness → happy
    ["fully",   "ful"],   // carefully → careful
    ["ously",   "ous"],   // famously → famous
    ["ively",   "ive"],   // actively → active
    ["ibly",    "ible"],  // impossibly → impossible
    ["ily",     "y"],     // happily → happy
    ["ally",    "al"],    // basically → basic
  ];
  for (const [from, to] of REPLACEMENTS) {
    if (!w.endsWith(from) || w.length <= from.length + 1) continue;
    const cand = w.slice(0, -from.length) + to;
    const r = rankOf(data, cand, depth + 1);
    if (r != null) return r;
  }

  // ----- Phase 3: simple suffix STRIPPING (broadest last) -----
  const SUFFIXES = [
    "ies", "ied", "ying",         // carry/carries/carried/carrying
    "iest", "ier",                // easy/easier/easiest
    "ing", "ed", "er", "est",     // walk/walking/walked/walker
    "ly",                          // immediate/immediately
    "es",                          // boxes→box, goes→go, tomatoes→tomato, does→do
    "s",                           // cat/cats  (last because very broad)
    "ful", "ness", "ment",        // delight/delightful, dark/darkness
    "al",                          // cultural
  ];
  for (const suf of SUFFIXES) {
    if (!w.endsWith(suf) || w.length <= suf.length + 1) continue;
    const stem = w.slice(0, -suf.length);
    // Bare stem
    const r0 = rankOf(data, stem, depth + 1);
    if (r0 != null) return r0;
    // + silent-e
    const r1 = rankOf(data, stem + "e", depth + 1);
    if (r1 != null) return r1;
    // De-double final consonant (running → run, stopped → stop)
    if (stem.length > 1 && stem[stem.length - 1] === stem[stem.length - 2]
        && /[bcdfghjklmnpqrstvwxz]/.test(stem[stem.length - 1])) {
      const r2 = rankOf(data, stem.slice(0, -1), depth + 1);
      if (r2 != null) return r2;
      const r3 = rankOf(data, stem.slice(0, -1) + "e", depth + 1);
      if (r3 != null) return r3;
    }
  }
  return null;
}

/**
 * Lemmatize a word: return the COCA headword that the surface form maps to.
 * Uses the same chain as rankOf (contraction → prefix → suffix) but returns
 * the matched lemma string instead of the rank.  Falls back to the original
 * token when no headword is found.
 */
export function lemmatizeWord(data: CocaData | null, word: string, depth = 0): string {
  if (!data || depth > 2) return word;
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return word;
  // contraction expand first
  const norm = normalizeToken(w);
  if (norm && data.ranks[norm] != null) return norm;
  if (w in data.ranks) return w;
  if (norm && norm in data.ranks) return norm;
  // irregular inflections (exception dictionary) — before length guard
  const irr = IRREGULAR[w];
  if (irr != null && irr in data.ranks) return irr;
  if (w.length < 4) return word;
  // prefix strip
  const PREFIXES = ["im", "in", "ir", "un", "non", "dis", "re", "pre", "mis", "over", "under"];
  for (const p of PREFIXES) {
    if (w.startsWith(p) && w.length > p.length + 3) {
      const cand = w.slice(p.length);
      if (data.ranks[cand] != null) return cand;
      const r = lemmatizeWord(data, cand, depth + 1);
      if (r !== cand) return r;
    }
  }
  // suffix replacements
  const REPL: [string, string][] = [
    ["ication","y"],["ically","y"],["ical","y"],["ities","ity"],
    ["iest","y"],["ier","y"],["ies","y"],["ied","y"],
    ["ation","ate"],["tion","te"],["ian","y"],["iness","y"],
    ["fully","ful"],["ously","ous"],["ively","ive"],["ibly","ible"],
    ["ily","y"],["ally","al"],
  ];
  for (const [from, to] of REPL) {
    if (!w.endsWith(from) || w.length <= from.length + 1) continue;
    const cand = w.slice(0, -from.length) + to;
    if (data.ranks[cand] != null) return cand;
    const r = lemmatizeWord(data, cand, depth + 1);
    if (r !== cand) return r;
  }
  // simple suffix stripping
  const SUF = ["ies","ied","ying","iest","ier","ing","ed","er","est","ly","es","s","ful","ness","ment","al"];
  for (const suf of SUF) {
    if (!w.endsWith(suf) || w.length <= suf.length + 1) continue;
    const stem = w.slice(0, -suf.length);
    if (data.ranks[stem] != null) return stem;
    if (data.ranks[stem + "e"] != null) return stem + "e";
    if (stem.length > 1 && stem[stem.length - 1] === stem[stem.length - 2]
        && /[bcdfghjklmnpqrstvwxz]/.test(stem[stem.length - 1])) {
      const d = stem.slice(0, -1);
      if (data.ranks[d] != null) return d;
      if (data.ranks[d + "e"] != null) return d + "e";
    }
  }
  return word;
}

/** Build a list of unique words from a token array, sorted by COCA rank asc. */
export function rankedUnique(
  data: CocaData | null,
  tokens: { text: string }[]
): { text: string; rank: number | null; band: Band }[] {
  const seen = new Set<string>();
  const out: { text: string; rank: number | null; band: Band }[] = [];
  for (const t of tokens) {
    const w = t.text.toLowerCase().replace(/[^a-z']/g, "");
    if (!w || seen.has(w)) continue;
    seen.add(w);
    const r = data?.ranks[w] ?? null;
    out.push({ text: w, rank: r, band: bandOf(data, w) });
  }
  out.sort((a, b) => {
    // 1) in-bands first, then above-band, then unknown (null rank)
    if (a.rank == null && b.rank == null) return 0;
    if (a.rank == null) return 1;
    if (b.rank == null) return -1;
    return a.rank - b.rank;
  });
  return out;
}

export const BAND_META: Record<
  Exclude<Band, null>,
  { label: string; color: string; rgb: string; description: string }
> = {
  "1k":   { label: "1k",   color: "#16a34a", rgb: "22,163,74",   description: "Top 1,000 (most common)" },
  "3k":   { label: "3k",   color: "#65a30d", rgb: "101,163,13", description: "1k–3k" },
  "5k":   { label: "5k",   color: "#2563eb", rgb: "37,99,235",   description: "3k–5k" },
  "6k":   { label: "6k",   color: "#eab308", rgb: "234,179,8",  description: "5k–6k" },
  "above":{ label: "6k+",  color: "#dc2626", rgb: "220,38,38",  description: "Beyond top 6,000" },
};

export function useVisibleBands(): [Set<Exclude<Band, null>>, (b: Exclude<Band, null>, on: boolean) => void] {
  const key = "lingo-coca-bands";
  const [vis, setVis] = useState<Set<Exclude<Band, null>>>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return new Set(JSON.parse(raw));
    } catch {/* ignore */}
    return new Set(["1k", "3k", "5k", "6k", "above"]);
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify([...vis])); } catch {/* ignore */}
  }, [vis]);
  return [vis, (b, on) => {
    setVis((prev) => {
      const next = new Set(prev);
      if (on) next.add(b); else next.delete(b);
      return next;
    });
  }];
}
