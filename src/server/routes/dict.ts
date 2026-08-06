// Offline dictionary via MDict (.mdx) — mirrors the original Enjoy app.
// Reads .mdx files dropped into <library>/dictionaries. No LLM / cloud needed
// for word lookup; this fully replaces the old LLM-based /api/words/lookup.
import express from "express";
import fs from "fs";
import path from "path";
import { Mdict } from "@divisey/js-mdict";
import { getLibraryPath } from "../db.js";
import { chatWithLLM } from "../engines/index.js";

interface DictCtx {
  readSettings: () => any;
  resolveLlm: (s: any) => any;
}

export function registerDictRoutes(app: express.Express, ctx: DictCtx) {
  const { readSettings, resolveLlm } = ctx;
type LoadedDict = { title: string; reader: any; mdd: any[] };

let dictCache: LoadedDict[] | null = null;
let dictCacheKey = "";

function dictsDir(): string {
  return path.join(getLibraryPath(), "dictionaries");
}

// Re-scan only when the directory's contents/mtime change, so a dictionary
// dropped in after the server started is picked up without a restart.
function dirKey(dir: string): string {
  try {
    const mtime = fs.statSync(dir).mtimeMs;
    const files = fs.readdirSync(dir).sort().join("|");
    return `${mtime}:${files}`;
  } catch {
    return "";
  }
}

function loadDicts(): LoadedDict[] {
  const dir = dictsDir();
  const key = dirKey(dir);
  if (dictCache && key === dictCacheKey) return dictCache;
  dictCache = [];
  dictCacheKey = key;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  if (!fs.existsSync(dir)) return dictCache;
  const files = fs.readdirSync(dir);
  const mdds = files
    .filter((f) => f.toLowerCase().endsWith(".mdd"))
    .map((f) => new Mdict(path.join(dir, f)));
  for (const m of files.filter((f) => f.toLowerCase().endsWith(".mdx"))) {
    try {
      const reader = new Mdict(path.join(dir, m));
      dictCache.push({ title: m.replace(/\.mdx$/i, ""), reader, mdd: mdds });
    } catch (err) {
      console.error("[mdict] failed to load", m, err);
    }
  }
  return dictCache;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHtml(s: string): string {
  return s
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/\s+href="[^"]*"/g, "") // neutralize d:/help: cross-ref links
    .replace(/\s+onclick="[^"]*"/g, "");
}

// --- Structured, restricted dictionary display -------------------------------
// OALD8 groups CORE meanings in <span class="n-g"> (numbered groups, often
// marked with ★), idioms in <span class="id-g">, phrasal verbs in <span class="pv-g">.
// Produce a clean card: at most 2 parts of speech, 2 definitions each (numbered),
// English + Chinese on one line, up to 2 example sentences (◆ on their own line).
// Never emit ★ or duplicates.
const MAX_POS = 2;
const MAX_DEFS = 2;
const MAX_EXAMPLES = 2;

function textOf(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[★☆]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Returns the index just past the matching </span> for the <span> opened at openIdx.
function spanCloseEnd(html: string, openIdx: number): number {
  let i = html.indexOf(">", openIdx) + 1;
  let depth = 0;
  const n = html.length;
  while (i < n) {
    if (html.startsWith("<span", i)) {
      depth++;
      i = html.indexOf(">", i) + 1;
    } else if (html.startsWith("</span>", i)) {
      if (depth === 0) return i + "</span>".length;
      depth--;
      i += "</span>".length;
    } else i++;
  }
  return -1;
}
function firstSpanInner(html: string, cls: string): string | null {
  const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "i");
  const m = re.exec(html);
  if (!m) return null;
  const ote = html.indexOf(">", m.index);
  const c = spanCloseEnd(html, m.index);
  if (c < 0) return null;
  return html.slice(ote + 1, c - "</span>".length);
}
function allSpansInner(html: string, cls: string): string[] {
  const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const c = spanCloseEnd(html, m.index);
    if (c < 0) continue;
    const ote = html.indexOf(">", m.index);
    out.push(html.slice(ote + 1, c - "</span>".length));
  }
  return out;
}
interface DictDef {
  en: string;
  cn: string;
  examples: string[];
}
function parseDefInner(defHtml: string): { en: string; cn: string } | null {
  let label = "";
  const li = firstSpanInner(defHtml, "label-g");
  if (li) label = textOf(li);
  const enInner = firstSpanInner(defHtml, "d") || firstSpanInner(defHtml, "ud");
  if (!enInner) return null;
  const ci = firstSpanInner(enInner, "chn");
  const cn = ci ? textOf(ci) : "";
  let enClean = enInner;
  if (ci !== null) {
    const co = enInner.search(/<span\b[^>]*class="[^"]*\bchn\b[^"]*"/i);
    if (co >= 0) {
      const cc = spanCloseEnd(enInner, co);
      enClean = enInner.slice(0, co) + enInner.slice(cc);
    }
  }
  let en = textOf(enClean);
  if (label) en = label + " " + en;
  return { en, cn };
}
function examplesIn(win: string): string[] {
  const xgs = allSpansInner(win, "x-g");
  const out: string[] = [];
  for (const xi of xgs) {
    const x = firstSpanInner(xi, "x");
    if (x) {
      const ex = textOf(x);
      if (ex) out.push(ex);
    }
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out.slice(0, MAX_EXAMPLES);
}
function detectPos(region: string, full: string): string {
  const p = region.match(/class="pos"[^>]*>([^<]*)<\/span>/i);
  if (p && p[1].trim()) return p[1].trim();
  const vocab = [
    "noun","verb","adjective","adverb","preposition","conjunction",
    "pronoun","determiner","exclamation","abbreviation","numeral","modal",
  ];
  const hay = region + " " + full.slice(0, 1500);
  for (const v of vocab) if (new RegExp("\\b" + v + "\\b", "i").test(hay)) return v;
  return "";
}
// Ranges of idiom/phrasal-verb groups that carry an id/pv headword NOT equal to
// the entry headword. Used as a fallback when an entry has no n-g core groups.
function idiomRanges(html: string, word: string): [number, number][] {
  const ranges: [number, number][] = [];
  const wl = word.toLowerCase();
  for (const cls of ["id-g", "idm-g", "pv-g", "phrase", "phr-g"]) {
    const re = new RegExp('<span\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"', "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const c = spanCloseEnd(html, m.index);
      if (c < 0) continue;
      const ote = html.indexOf(">", m.index);
      const inner = html.slice(ote + 1, c - "</span>".length);
      const hm = inner.match(/<span\b[^>]*class="(id|pv)\s*"[^>]*>([\s\S]*?)<\/span>/i);
      if (hm) {
        const hw = textOf(hm[2]).toLowerCase();
        if (hw !== wl) ranges.push([m.index, c]);
      }
    }
  }
  return ranges;
}
function defsFromSection(secHtml: string, word: string): DictDef[] {
  const ngs = allSpansInner(secHtml, "n-g");
  const blocks: DictDef[] = [];
  if (ngs.length) {
    for (const ng of ngs) {
      const di = firstSpanInner(ng, "def-g");
      if (!di) continue;
      const p = parseDefInner(di);
      if (!p) continue;
      blocks.push({ ...p, examples: examplesIn(ng) });
    }
    return blocks;
  }
  // Fallback: no n-g core groups. Skip idiom/phrasal groups, keep remaining def-g.
  const ir = idiomRanges(secHtml, word);
  const inIdiom = (i: number) => ir.some(([a, b]) => i >= a && i < b);
  const re = /<span\b[^>]*class="[^"]*\bdef-g\b[^"]*"/gi;
  let dm: RegExpExecArray | null;
  while ((dm = re.exec(secHtml))) {
    if (inIdiom(dm.index)) continue;
    const c = spanCloseEnd(secHtml, dm.index);
    if (c < 0) continue;
    const ote = secHtml.indexOf(">", dm.index);
    const inner = secHtml.slice(ote + 1, c - "</span>".length);
    const p = parseDefInner(inner);
    if (!p) continue;
    blocks.push({ ...p, examples: examplesIn(inner) });
  }
  return blocks;
}

// Normalize a dictionary audio reference (e.g. sound://uk/run__gb_1.mp3 or
// snd://run__gb_1.spx) into the candidate keys used inside the companion .mdd.
// js-mdict stores resources with a leading backslash and backslash separators
// (e.g. \uk\run__gb_1.mp3), so we try a few plausible forms.
function audioKeyCandidates(ref: string): string[] {
  const noScheme = ref
    .replace(/^sound:\/\//i, "")
    .replace(/^snd:\/\//i, "")
    .replace(/^entry:\/\//i, "");
  const cands = new Set<string>();
  cands.add(noScheme);
  cands.add(noScheme.replace(/^\//, ""));
  cands.add("\\" + noScheme.replace(/\//g, "\\"));
  cands.add("\\" + noScheme.replace(/^\//, "").replace(/\//g, "\\"));
  return [...cands];
}

// Parse an Oxford-style MDict entry into structured fields for a clean card:
// headword, phonetic (IPA + audio ref), and per-part-of-speech sections.
function parseOxford(html: string, word: string) {
  let head = word;
  const hk = html.match(/<hkey>\s*<h[^>]*>([^<]*)<\/h>/);
  if (hk) head = hk[1].trim() || word;

  // Phonetics come from the headword block (<hkey> … <top-g>). The IPA lives in
  // <phon>, the BrE/NAmE labels in <brelabel>/<namelabel>, and the audio key in
  // <pron e gs href="…">. Oxford has no </pron> close, so we scope to that block.
  const phonetic: { label: string; ipa: string; audioRef: string }[] = [];
  const hkRegion = html.match(/<hkey>([\s\S]*?)<top-g>/);
  const region = hkRegion ? hkRegion[1] : html;

  // --- OALD8: <span class="phon-gb"> / <span class="phon-us"> + <a type="sound" href="sound://uk/.."> ---
  const gbIpa = region.match(/class="phon-gb"[^>]*>(.*?)<\/span>/i);
  const usIpa = region.match(/class="phon-us"[^>]*>(.*?)<\/span>/i);
  const soundHrefs = [
    ...region.matchAll(/type="sound"[^>]*\bhref="([^"]+)"/gi),
  ].map((m) => m[1]);
  // --- OALD9 fallback: <phon> + <brelabel>/<namelabel> + gs href ---
  const ipas9 = [...region.matchAll(/<phon>(.*?)<\/phon>/g)].map((m) => m[1]);
  const labels9 = [
    ...region.matchAll(
      /<brelabel>(.*?)<\/brelabel>|<namelabel>(.*?)<\/namelabel>/g
    ),
  ].map((m) => (m[1] || m[2]).replace(/<[^>]+>/g, "").trim());
  const gsRefs = [...region.matchAll(/\bgs href="([^"]+)"/g)].map((m) => m[1]);

  let brE: string | null = gbIpa ? gbIpa[1].trim() : null;
  let naE: string | null = usIpa ? usIpa[1].trim() : null;
  if (!brE || !naE) {
    labels9.forEach((lab, i) => {
      const ipa = ipas9[i];
      if (lab === "BrE" && !brE) brE = ipa;
      if (lab === "NAmE" && !naE) naE = ipa;
    });
  }
  const ukRef =
    soundHrefs.find((h) => /(^|\/)(uk|gb)/i.test(h)) || gsRefs[0] || "";
  const usRef =
    soundHrefs.find((h) => /(^|\/)(us|na)/i.test(h)) ||
    gsRefs[1] ||
    gsRefs[0] ||
    "";
  if (brE) phonetic.push({ label: "BrE", ipa: brE, audioRef: ukRef });
  if (naE) phonetic.push({ label: "NAmE", ipa: naE, audioRef: usRef });

  const sections: { pos: string; html: string }[] = [];
  // OALD9 (legacy 9th-edition layout): <div id="verb" class="cixing_part"> ...
  const secRe =
    /<div id="([^"]+)" class="cixing_part">([\s\S]*?)(?=<div id="[^"]+" class="cixing_part">|$)/g;
  let sm: RegExpExecArray | null;
  let used9 = false;
  while ((sm = secRe.exec(html))) {
    used9 = true;
    const pos = sm[1];
    let body = sm[2].replace(/<hkey>[\s\S]*?<\/hkey>/, ""); // drop repeated headword+IPA block
    body = cleanHtml(body);
    sections.push({ pos, html: body });
  }
  // OALD8: <span ... bookmark="WORD_pos_X" class="Ref"><a backup-class="pos">verb</a>
  //        labels the section; the content is wrapped in <span id="WORD_pos_X">.
  if (!used9) {
    const posAnchors = [
      ...region.matchAll(
        /<span\b[^>]*\bbookmark="([^"]+)"[^>]*>[\s\S]*?<a\b[^>]*\bbackup-class="pos"[^>]*>([^<]*)<\/a>/gi
      ),
    ].map((m) => ({ id: m[1], label: m[2].trim() }));
    if (posAnchors.length) {
      for (let i = 0; i < posAnchors.length; i++) {
        const { id, label } = posAnchors[i];
        const sIdx = html.indexOf(`id="${id}"`);
        if (sIdx < 0) continue;
        const tagEnd = html.indexOf(">", sIdx);
        const nextMarker = posAnchors[i + 1]
          ? html.indexOf(`id="${posAnchors[i + 1].id}"`, tagEnd)
          : -1;
        const endIdx = nextMarker > 0 ? nextMarker : html.length;
        const body = cleanHtml(html.slice(tagEnd + 1, endIdx));
        sections.push({ pos: label || id, html: body });
      }
    } else {
      // Single-POS entries (cat, beautiful, …) have no section wrappers. Use the
      // whole entry and let detectPos figure out the part of speech.
      sections.push({ pos: detectPos(region, html), html: cleanHtml(html) });
    }
  }

  // Restrict to a clean card: at most 2 parts of speech, 2 definitions each.
  const pos: {
    pos: string;
    defs: { num: number; en: string; cn: string; examples: string[] }[];
  }[] = [];
  const seenDefs = new Set<string>();
  for (const sec of sections.slice(0, MAX_POS)) {
    const blocks = defsFromSection(sec.html, word);
    const defs: { num: number; en: string; cn: string; examples: string[] }[] = [];
    for (const b of blocks) {
      if (defs.length >= MAX_DEFS) break;
      const key = b.en.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seenDefs.has(key)) continue;
      seenDefs.add(key);
      defs.push({ num: defs.length + 1, en: b.en, cn: b.cn, examples: b.examples });
    }
    if (defs.length) pos.push({ pos: sec.pos, defs });
  }
  return { word: head, phonetic, pos };
}

function getMddReaders(): any[] {
  return loadDicts().flatMap((d) => d.mdd || []);
}

// Look up an audio resource in the companion .mdd, trying every candidate key
// form. Returns the raw definition (audio bytes) and the matched key, or null.
function mddLookup(ref: string): { def: any; key: string } | null {
  if (!ref) return null;
  const cands = audioKeyCandidates(ref);
  for (const m of getMddReaders()) {
    for (const c of cands) {
      try {
        const r: any = m.lookup(c);
        if (r && r.definition) {
          const d = r.definition;
          const len = Buffer.isBuffer(d)
            ? d.length
            : typeof d === "string"
            ? d.length
            : 0;
          if (len > 0) return { def: d, key: c };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// True only if the .mdd actually contains non-empty data for this key
// (some .mdd files are key-index stubs without the audio/picture bytes).
function mddHas(ref: string): boolean {
  return mddLookup(ref) != null;
}

// Irregular noun/verb inflections → base form (lemma). Used as a high-confidence
// fallback when an exact headword match fails, so inflected tokens still resolve.
const IRREGULAR: Record<string, string> = {
  // nouns
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", people: "person", oxen: "ox", calves: "calf",
  halves: "half", leaves: "leaf", wolves: "wolf", selves: "self", knives: "knife",
  lives: "life", wives: "wife", elves: "elf", loaves: "loaf", shelves: "shelf",
  thieves: "thief",
  // verbs (past / participle)
  went: "go", gone: "go", wrote: "write", written: "write", came: "come",
  became: "become", took: "take", taken: "take", gave: "give", given: "give",
  fell: "fall", fallen: "fall", grew: "grow", grown: "grow", knew: "know",
  known: "know", threw: "throw", thrown: "throw", drew: "draw", drawn: "draw",
  flew: "fly", flown: "fly", blew: "blow", blown: "blow", spoke: "speak",
  spoken: "speak", broke: "break", broken: "break", bore: "bear", born: "bear",
  wore: "wear", worn: "wear", tore: "tear", torn: "tear", stole: "steal",
  stolen: "steal", drove: "drive", driven: "drive", rode: "ride", ridden: "ride",
  rose: "rise", risen: "rise", chose: "choose", chosen: "choose", shook: "shake",
  shaken: "shake", froze: "freeze", frozen: "freeze", awoke: "awake",
  woke: "wake", woken: "wake", sank: "sink", sunk: "sink", swam: "swim",
  swum: "swim", began: "begin", begun: "begin", drank: "drink", drunk: "drink",
  rang: "ring", rung: "ring", sang: "sing", sung: "sing", sprang: "spring",
  sprung: "spring", stood: "stand", understood: "understand", held: "hold",
  kept: "keep", slept: "sleep", felt: "feel", left: "leave", lost: "lose",
  met: "meet", sent: "send", spent: "spend", built: "build", lit: "light",
  burnt: "burn", learnt: "learn", learned: "learn", meant: "mean", bent: "bend",
  lent: "lend", dealt: "deal", heard: "hear", led: "lead", fed: "feed",
  bled: "bleed", fled: "flee", shed: "shed", read: "read", put: "put",
  cut: "cut", set: "set", hit: "hit", let: "let", shut: "shut", cost: "cost",
  burst: "burst", cast: "cast", split: "split", spread: "spread",
  brought: "bring", bought: "buy", thought: "think", caught: "catch",
  taught: "teach", fought: "fight", sought: "seek", made: "make", did: "do",
  done: "do", saw: "see", seen: "see", dug: "dig", stuck: "stick",
  struck: "strike", strung: "string", swung: "swing", hung: "hang",
  won: "win", ran: "run", mistook: "mistake", undertook: "undertake",
  withdrew: "withdraw", overcame: "overcome", underwent: "undergo",
  withheld: "withhold", upheld: "uphold", sped: "speed", swept: "sweep",
  wept: "weep", crept: "creep", dwelt: "dwell", forbade: "forbid",
  forgot: "forget", forgotten: "forget", forbore: "forbear",
  outdid: "outdo", reset: "reset", retook: "retake",
};

// Generate candidate base forms for an inflected token. Order matters: the
// most confident (irregular, then unambiguous plural rules) come first; generic
// -s/-es stripping is tried last and verified by an actual dictionary lookup.
function lemmaCandidates(w: string): string[] {
  const low = w.toLowerCase();
  const out: string[] = [];
  if (IRREGULAR[low]) out.push(IRREGULAR[low]);
  const rules: [RegExp, string][] = [
    [/ies$/, "y"], // babies → baby
    [/yses$/, "ysis"], // analyses → analysis
    [/ches$/, "ch"], // watches → watch
    [/shes$/, "sh"], // dishes → dish
    [/sses$/, "ss"], // classes → class
    [/xes$/, "x"], // boxes → box
    [/oes$/, "o"], // tomatoes → tomato
    [/s$/, ""], // cats → cat, uses → use (try just -s first)
    [/es$/, ""], // boxes/classes fallback → box/class
    [/ied$/, "y"], // tried → try, copied → copy
    [/ed$/, ""], // planned → plan, washed → wash
    [/d$/, ""], // loved → love, used → use
    [/ing$/, ""], // running → run, stopping → stop
    [/ing$/, "e"], // making → make, loving → love
    [/er$/, ""], // faster → fast
    [/er$/, "e"], // nicer → nice
    [/est$/, ""], // fastest → fast
    [/est$/, "e"], // nicest → nice
  ];
  if (low.length > 3) {
    for (const [re, rep] of rules) {
      if (re.test(low)) {
        const cand = low.replace(re, rep);
        if (cand.length >= 2) out.push(cand);
      }
    }
  }
  return Array.from(new Set(out));
}

// Try the word (and its case variants) against every loaded dictionary.
// Returns a fully-shaped result, or null if no dictionary has it.
function tryVariants(dicts: any[], word: string): any | null {
  const variants = Array.from(
    new Set([
      word,
      word.toLowerCase(),
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    ])
  );
  for (const d of dicts) {
    for (const w of variants) {
      try {
        let def: string | null = d.reader.lookup(w)?.definition ?? null;
        if (def && def.startsWith("@@@LINK=")) {
          def = d.reader.lookup(def.substring(8))?.definition ?? null;
        }
        if (def) {
          const entry = parseOxford(def, word);
          return {
            word,
            found: true,
            html: def,
            text: stripTags(def),
            dictTitle: d.title,
            entry,
            hasMdd: dicts.some((x) => (x.mdd || []).length > 0),
            audioAvailable: entry.phonetic.some(
              (p: any) => p.audioRef && mddHas(p.audioRef)
            ),
          };
        }
      } catch (err) {
        console.error("[mdict] lookup error", w, err);
      }
    }
  }
  return null;
}

function lookupWord(word: string) {
  const dicts = loadDicts();
  // Exact headword match first (as typed / lowercase / Title-case).
  const exact = tryVariants(dicts, word);
  if (exact) return exact;
  // No exact entry — the token is almost certainly an inflected form (plural,
  // verb tense, comparative). Strip the inflectional suffix / map the irregular
  // form and retry on the base (lemma). The first lemma that actually exists
  // in the dictionary wins.
  for (const lemma of lemmaCandidates(word)) {
    const r = tryVariants(dicts, lemma);
    if (r) {
      return { ...r, lemmatized: true, lemma, word };
    }
  }
  return {
    word,
    found: false,
    html: null,
    text: null,
    dictTitle: null,
    hasMdd: dicts.some((x) => (x.mdd || []).length > 0),
    audioAvailable: false,
  };
}

app.get("/api/dict/list", (_req, res) => {
  const dicts = loadDicts();
  res.json({ dictionaries: dicts.map((d) => d.title), dir: dictsDir() });
});

app.get("/api/dict/lookup", (req, res) => {
  const word = String(req.query.word || "").trim();
  if (!word) return res.status(400).json({ error: "word required" });
  const r = lookupWord(word);
  if (!r.found) {
    return res.json({
      ...r,
      message: "No local dictionary entry. Drop a .mdx file into " + dictsDir(),
    });
  }
  res.json(r);
});

// LLM fallback for words with no local MDict entry. Returns a concise,
// dictionary-style explanation (part of speech + 2 definitions + 2 examples).
const DEFAULT_DICT_LLM_PROMPT = `You are a concise bilingual dictionary. For the headword "{WORD}", provide:
- Part of speech (e.g. n. / v. / adj. / adv.)
- Two clear definitions: a short English explanation followed by a concise Chinese translation.
- Two representative example sentences (English) showing natural usage.
Keep the entire answer under 150 words. Plain text, no markdown headings, no bullets beyond the structure above.`;

app.post("/api/dict/llm", async (req, res) => {
  try {
    const settings = readSettings();
    const word = String(req.body.word || "").trim();
    if (!word) return res.status(400).json({ error: "word required" });
    const { learning, native } = settings.languages || { learning: "en", native: "zh" };
    const system = (settings.prompts?.dictLlm || DEFAULT_DICT_LLM_PROMPT)
      .replaceAll("{WORD}", word)
      .replaceAll("{L}", learning)
      .replaceAll("{N}", native);
    const content = await chatWithLLM(
      [
        { role: "system", content: system },
        { role: "user", content: `Headword: ${word}` },
      ],
      resolveLlm(settings)
    );
    res.json({ content });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Pronunciation audio — served from the companion .mdd resource file.
// The audio reference (e.g. sound://uk/run__gb_1.mp3) is mapped to the .mdd key.
app.get("/api/dict/audio", (req, res) => {
  const ref = String(req.query.ref || "").trim();
  if (!ref) return res.status(400).json({ error: "ref required" });
  const found = mddLookup(ref);
  if (!found) {
    return res
      .status(404)
      .json({ error: "audio resource not found in .mdd: " + ref });
  }
  try {
    const def = found.def;
    // js-mdict returns binary resources (audio/images) as base64-encoded strings,
    // so decode accordingly; raw Buffers (if any) pass through unchanged.
    const buf = Buffer.isBuffer(def)
      ? def
      : Buffer.from(def as string, "base64");
    const ext = (found.key.split(".").pop() || "mp3").toLowerCase();
    const ct: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      spx: "audio/ogg",
      flac: "audio/flac",
    };
    res.set("Content-Type", ct[ext] || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch (e) {
    console.error("[mdict] audio lookup error", ref, e);
    return res.status(500).json({ error: "audio decode failed" });
  }
});
}
