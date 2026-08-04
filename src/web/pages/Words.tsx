import { useEffect, useMemo, useState } from "react";
import { api, type Word } from "../api";
import { useCoca, rankOf, bandOf, BAND_META, type Band } from "../lib/coca";
import WordPanel, { type WordPanelData } from "../components/WordPanel";
import { IconPlus, IconSearch } from "../components/Icon";

type Filter = "all" | Exclude<Band, null>;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "1k", label: "1k" },
  { id: "3k", label: "3k" },
  { id: "5k", label: "5k" },
  { id: "6k", label: "6k" },
  { id: "above", label: "6k+" },
];

export default function Words() {
  const coca = useCoca();
  const [words, setWords] = useState<Word[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<WordPanelData | null>(null);

  async function load() {
    setWords(await api.listWords());
  }
  useEffect(() => {
    load();
  }, []);

  // Compute the COCA band for every word, and a display term (strip meaning
  // noise). We tag each word with its band so the grid can be filtered.
  const tagged = useMemo(() => {
    return words.map((w) => ({
      word: w,
      band: bandOf(coca, w.term) ?? "above",
    }));
  }, [words, coca]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tagged.filter((t) => {
      if (filter !== "all" && t.band !== filter) return false;
      if (q && !t.word.term.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tagged, filter, search]);

  async function add() {
    if (!term.trim()) return;
    await api.createWord({ term: term.trim() });
    setTerm("");
    await load();
  }

  async function remove(id: string) {
    await api.deleteWord(id);
    await load();
  }

  function open(w: Word) {
    setPanel({
      text: w.term,
      context: w.example || "",
      isWord: true,
      band: bandOf(coca, w.term),
    });
  }

  return (
    <div className="flex h-full">
      {/* Full content area — word cards grid + COCA filter */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        {/* Header + filter */}
        <div className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-lg font-semibold">Words</h1>
              <p className="text-xs text-muted-foreground">
                {words.length} saved · click a card to open its dictionary. Aggregated by COCA frequency band.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <IconSearch size={15} />
                </span>
                <input
                  className="input pl-8"
                  style={{ width: 200 }}
                  placeholder="Search words…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
                className="flex items-center gap-1"
              >
                <input
                  className="input"
                  style={{ width: 160 }}
                  placeholder="Add a word"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
                <button className="btn btn-primary inline-flex items-center gap-1" type="submit">
                  <IconPlus size={15} /> Add
                </button>
              </form>
            </div>
          </div>

          {/* COCA band filter chips */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {FILTERS.map((f) => {
              const active = filter === f.id;
              const meta =
                f.id === "all" ? null : BAND_META[f.id as Exclude<Band, null>];
              const style = meta
                ? {
                    borderColor: active ? meta.color : "transparent",
                    background: active ? `rgba(${meta.rgb},0.16)` : "transparent",
                    color: active ? meta.color : "var(--muted-foreground)",
                  }
                : undefined;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className="filter-chip"
                  style={style}
                >
                  {meta && (
                    <span
                      className="inline-block rounded-full"
                      style={{
                        width: 8,
                        height: 8,
                        background: meta.color,
                        marginRight: 6,
                      }}
                    />
                  )}
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Card grid */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground p-6 text-center">
              No words match this filter.
            </div>
          ) : (
            <div className="word-grid">
              {filtered.map(({ word, band }) => {
                const meta = BAND_META[band as Exclude<Band, null>];
                return (
                  <div
                    key={word.id}
                    className="word-card"
                    onClick={() => open(word)}
                    title={`${word.term} · COCA ${meta.label}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="word-card-term" style={{ color: meta.color }}>{word.term}</span>
                      <span className="word-card-del"
                        onClick={(e) => { e.stopPropagation(); remove(word.id); }}
                        title="Delete">✕</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right slide-in dictionary panel — same style as the audio page */}
      <WordPanel data={panel} dictOnly onClose={() => setPanel(null)} />
    </div>
  );
}
