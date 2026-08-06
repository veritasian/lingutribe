// Right slide-in panel: shows dictionary + AI explanation for a word
// or sentence clicked in the transcript. The transcript is the source
// of truth; this panel just renders the analysis.

import { useEffect, useState } from "react";
import { api, type SavedPrompt } from "../api";
import { rankOf, useCoca, type Band } from "../lib/coca";
import { IconVolume, IconCopy, IconTrash } from "./Icon";
import { renderMarkdown } from "../lib/markdown";

export interface WordPanelData {
  // Source text — could be a single token (e.g. "habituate") or
  // a multi-word phrase the user selected.
  text: string;
  // The local context sentence (already trimmed).
  context: string;
  // Whether this came from clicking a single word (true) or a span (false).
  isWord: boolean;
  // The COCA rank if known.
  rank?: number | null;
  band?: "1k" | "3k" | "5k" | "6k" | "above" | null;
  // Which tab to open when this panel is shown (Feature: Ask AI).
  defaultTab?: "dict" | "grammar" | "ask";
  // Chat thread key for the Ask AI tab (e.g. the article/resource id).
  thread?: string;
  // Full article text, used as context for the Ask AI tab.
  article?: string;
}

type AskMsg = { id?: string; role: "user" | "assistant"; content: string };

export default function WordPanel({
  data,
  onClose,
  onAdded,
  dictOnly,
  width,
  onWidthChange,
}: {
  data: WordPanelData | null;
  onClose: () => void;
  onAdded?: (term: string) => void;
  // When true, only the dictionary tab is shown (no Grammar/AI analysis).
  dictOnly?: boolean;
  // Draggable width (px). Controlled by the parent so the layout reflows.
  width?: number;
  onWidthChange?: (w: number) => void;
}) {
  const coca = useCoca();
  const [lookup, setLookup] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [tab, setTab] = useState<"dict" | "grammar" | "ask">("dict");
  const [added, setAdded] = useState(false);

  // Feature 1: LLM fallback definition when no local MDict entry exists.
  const [llmDef, setLlmDef] = useState<string | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);

  // Feature 2: Ask AI chat.
  const [askMsgs, setAskMsgs] = useState<AskMsg[]>([]);
  const [askInput, setAskInput] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const askThread = data?.thread || "global";

  // Slash-command menu: saved prompts inserted via "/".
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [showPromptMenu, setShowPromptMenu] = useState(false);
  const [promptQuery, setPromptQuery] = useState("");
  const [promptHi, setPromptHi] = useState(0);

  // Real rank via the COCA lemmatizer.
  const realRank = data && coca ? rankOf(coca, data.text) : null;
  const realBand: Band = (() => {
    if (!realRank) return data?.band ?? null;
    if (realRank <= 1000) return "1k";
    if (realRank <= 3000) return "3k";
    if (realRank <= 5000) return "5k";
    if (realRank <= 6000) return "6k";
    return "above";
  })();

  // Open on the requested tab when a new item is selected.
  useEffect(() => {
    if (data) setTab(data.defaultTab ?? "dict");
  }, [data]);

  useEffect(() => {
    if (!data) {
      setLookup(null);
      setError(null);
      setAnalysis(null);
      setLlmDef(null);
      setAdded(false);
      return;
    }
    setAdded(false);
    setAnalysis(null);
    setLlmDef(null);
    // Switching to a different resource/thread must start a FRESH blank
    // conversation — never show the previous resource's chat here.
    setAskMsgs([]);
    // Skip the (local) dictionary lookup when opened straight on the Ask AI tab.
    if (data.isWord && data.defaultTab !== "ask") {
      setLoading(true);
      setError(null);
      setLookup(null);
      api
        .dictLookup(data.text)
        .then((r) => {
          setLookup(r);
          // Feature 1: no local entry → ask the LLM for a concise definition.
          if (!r.found) {
            setLlmLoading(true);
            api
              .dictLlm(data.text)
              .then((d) => setLlmDef(d.content))
              .catch((e) => setLlmDef("AI lookup failed: " + (e.message || "")))
              .finally(() => setLlmLoading(false));
          }
        })
        .catch((e) => setError(e.message || "lookup failed"))
        .finally(() => setLoading(false));
    }
  }, [data?.text, data?.context, data?.isWord, data?.defaultTab, data?.thread]);

  // Feature 2: load persisted chat when the Ask AI tab is shown.
  useEffect(() => {
    if (tab === "ask") {
      api
        .chatHistory(askThread)
        .then((r) =>
          setAskMsgs(
            r.messages.map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
            }))
          )
        )
        .catch(() => {});
      // Load saved prompts so the "/" slash menu can offer them.
      api
        .getSettings()
        .then((s) => setSavedPrompts(s.prompts?.list || []))
        .catch(() => {});
    }
  }, [tab, askThread]);

  async function add() {
    if (!data) return;
    await api.createWord({
      term: data.text,
      meaning: lookup?.text || lookup?.html || "",
    });
    setAdded(true);
    onAdded?.(data.text);
  }

  function playAudio(ref: string) {
    const a = new Audio("/api/dict/audio?ref=" + encodeURIComponent(ref));
    a.play().catch(() => {
      /* no .mdd → 404 JSON body; silently ignore */
    });
  }

  async function analyze() {
    if (!data) return;
    setAnalyzing(true);
    try {
      const r = await api.analyze(data.isWord ? data.context || data.text : data.text);
      setAnalysis(r.content);
    } catch (e: any) {
      setAnalysis(`Error: ${e.message}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function askSend() {
    const text = askInput.trim();
    if (!text || askBusy) return;
    setAskInput("");
    setAskBusy(true);
    try {
      // Persist the user message first so it gets a stable id (used by delete).
      const saved = await api.saveChatMessage(askThread, "user", text);
      const history = [...askMsgs, { id: saved.id, role: "user" as const, content: text }];
      setAskMsgs(history);
      const system = buildAskSystem(data);
      const messages = [
        { role: "system" as const, content: system },
        ...askMsgs.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: text },
      ];
      const reply = await api.chat(messages);
      const assistantContent = reply.content;
      const asst = await api.saveChatMessage(askThread, "assistant", assistantContent);
      setAskMsgs([...history, { id: asst.id, role: "assistant", content: assistantContent }]);
    } catch (e: any) {
      setAskMsgs([...askMsgs, { role: "assistant", content: "Error: " + e.message }]);
    } finally {
      setAskBusy(false);
    }
  }

  // Delete a single Ask-AI message (server + local).
  async function deleteAskMsg(i: number) {
    const m = askMsgs[i];
    if (!m) return;
    if (m.id) {
      try {
        await api.deleteChatMessage(m.id);
      } catch {
        /* keep going — remove locally regardless */
      }
    }
    setAskMsgs((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Detect a "/query" token at the cursor so we can pop the saved-prompt menu.
  const filteredPrompts = savedPrompts.filter((p) =>
    p.name.toLowerCase().includes(promptQuery.toLowerCase())
  );

  function onAskInputChange(v: string) {
    setAskInput(v);
    const m = v.match(/(?:^|\s)(\/[^\s/]*)$/);
    if (m) {
      setShowPromptMenu(true);
      setPromptQuery(m[1].slice(1)); // drop the leading "/"
      setPromptHi(0);
    } else {
      setShowPromptMenu(false);
      setPromptQuery("");
    }
  }

  // Insert a saved prompt (name + content) in place of the "/query" token.
  function applyPrompt(p: SavedPrompt) {
    const full = askInput;
    const m = full.match(/(?:^|\s)(\/[^\s/]*)$/);
    const insert = `${p.name}\n${p.content}`;
    if (!m) {
      // No slash token (e.g. menu opened manually) — just append.
      setAskInput(full + (full && !full.endsWith("\n") ? "\n" : "") + insert);
    } else {
      const start = (m.index ?? 0) + (m[0].length - m[1].length); // position before "/"
      const next = full.slice(0, start) + insert + full.slice(start + m[1].length);
      setAskInput(next);
    }
    setShowPromptMenu(false);
    setPromptQuery("");
  }

  function onAskKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showPromptMenu && filteredPrompts.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPromptHi((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPromptHi((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        applyPrompt(filteredPrompts[promptHi]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowPromptMenu(false);
        setPromptQuery("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      askSend();
    }
  }

  if (!data) return null;

  return (
    <aside
      className="relative shrink-0 border-l flex flex-col h-full overflow-hidden bg-card"
      style={{ width: width ?? 360, animation: "wp-slide-in 0.18s ease-out" }}
    >
      {/* Drag handle to resize the panel width (left edge) */}
      <div
        className="wp-resizer"
        onPointerDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = width ?? 360;
          const onMove = (ev: PointerEvent) => {
            const delta = startX - ev.clientX;
            let nw = startW + delta;
            nw = Math.max(280, Math.min(640, nw));
            onWidthChange?.(nw);
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
          };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        title="Drag to resize"
      />
      <style>{`@keyframes wp-slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>

      {/* Header */}
      <div className="px-4 py-3 border-b flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold truncate flex items-center gap-2">
            <span>{data.text}</span>
            {realBand && realBand !== "above" && realRank != null && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: `rgba(${bandRgb(realBand)},0.18)`, color: bandColor(realBand) }}
                title={`COCA rank #${realRank}`}
              >
                COCA {realBand}
              </span>
            )}
          </div>
          {data.context && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2 italic">
              “{data.context}”
            </div>
          )}
        </div>
        <button className="btn btn-ghost px-2" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {/* Tabs (hidden when dictOnly) */}
      {!dictOnly && (
        <div className="flex border-b text-sm">
          {(["dict", "grammar", "ask"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 transition-colors ${
                tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"
              }`}
            >
              {t === "dict" ? "Dictionary" : t === "grammar" ? "Grammar" : "Ask AI"}
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div
        className={
          tab === "ask"
            ? "flex-1 flex flex-col min-h-0 p-4 text-sm"
            : "scroll flex-1 p-4 text-sm space-y-3"
        }
      >
        {loading && <div className="text-muted-foreground">Looking up…</div>}
        {error && <div className="text-red-500">{error}</div>}

        {lookup && !lookup.error && tab === "dict" && (
          <>
            {lookup.found ? (
              <div className="space-y-4">
                {/* word + IPA + audio */}
                <div>
                  <div className="text-xl font-bold leading-tight">
                    {lookup.entry?.word || data.text}
                  </div>
                  {lookup.entry?.phonetic?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 items-center text-muted-foreground">
                      {lookup.entry.phonetic.map((p: any, i: number) => (
                        <span key={i} className="flex items-center gap-1">
                          {p.label && (
                            <span className="text-[10px] uppercase tracking-wide">{p.label}</span>
                          )}
                          <span className="font-mono text-[13px]">{p.ipa}</span>
                          {p.audioRef && (
                            <button
                              className="mdict-audio inline-flex items-center"
                              title={
                                lookup.audioAvailable
                                  ? "Play pronunciation"
                                  : "This .mdd doesn't bundle audio"
                              }
                              disabled={!lookup.audioAvailable}
                              onClick={() => playAudio(p.audioRef)}
                            >
                              <IconVolume size={15} />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {lookup.dictTitle && (
                    <div className="text-[11px] text-muted-foreground mt-1">
                      — {lookup.dictTitle}
                    </div>
                  )}
                  {lookup.lemmatized && lookup.lemma && (
                    <div className="text-[11px] mt-1 text-primary/90">
                      变形 of “{lookup.lemma}” · inflected form
                    </div>
                  )}
                </div>

                {/* part-of-speech sections — restricted: max 2 POS, 2 numbered
                    definitions each (English + Chinese on one line, ◆ examples) */}
                {lookup.entry?.pos?.length > 0 ? (
                  lookup.entry.pos.map((pb: any, i: number) => (
                    <div key={i} className="mdict-section">
                      {pb.pos ? <div className="mdict-pos">{pb.pos}</div> : null}
                      {pb.defs.map((d: any, j: number) => (
                        <div key={j} className="mdict-def">
                          <div className="mdict-def-line">
                            <span className="mdict-num">{d.num}.</span>
                            <span className="mdict-en">{d.en}</span>
                            {d.cn ? <span className="mdict-cn">{d.cn}</span> : null}
                          </div>
                          {d.examples?.map((ex: string, k: number) => (
                            <div key={k} className="mdict-ex">
                              ◆ {ex}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))
                ) : (
                  <div className="mdict-entry text-[13px] leading-relaxed">
                    {lookup.text || "No local dictionary entry for this word."}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-muted-foreground">
                  {lookup.message || "No local dictionary entry for this word."}
                </div>
                {llmLoading && <div className="text-muted-foreground">Asking AI…</div>}
                {llmDef && (
                  <div className="mdict-section">
                    <div className="text-[11px] text-muted-foreground mb-1">AI definition</div>
                    <div className="mdict-entry text-[13px] leading-relaxed">
                      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(llmDef) }} />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="pt-2">
              <button className="btn btn-primary w-full" disabled={added} onClick={add}>
                {added ? "Added to Words ✓" : "+ Add to Words"}
              </button>
            </div>
          </>
        )}

        {tab === "grammar" && (
          <>
            <button
              className="btn btn-secondary w-full"
              onClick={analyze}
              disabled={analyzing}
            >
              {analyzing ? "Analyzing…" : "Analyze with AI"}
            </button>
            {analysis && (
              <div className="text-[13px] leading-relaxed border-t pt-3">
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(analysis) }} />
              </div>
            )}
          </>
        )}

        {tab === "ask" && (
          <>
            {data.text && !data.isWord && (
              <div className="text-[11px] text-muted-foreground mb-2 border-l-2 pl-2 italic line-clamp-3">
                “{data.text}”
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
              {askMsgs.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  Ask anything about this text. Your chat is saved automatically.
                </div>
              )}
              {askMsgs.map((m, i) => (
                <div
                  key={i}
                  className={`group relative text-[13px] leading-relaxed rounded-lg px-3 py-2 ${
                    m.role === "user" ? "bg-primary/10 ml-6" : "bg-muted mr-6"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  ) : (
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  )}
                  {/* Copy / delete per message (SVG icons, shown on hover) */}
                  <div className="absolute -top-2 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="ask-msg-btn"
                      title="Copy"
                      aria-label="Copy message"
                      onClick={() => navigator.clipboard?.writeText(m.content)}
                    >
                      <IconCopy size={12} />
                    </button>
                    <button
                      className="ask-msg-btn"
                      title="Delete"
                      aria-label="Delete message"
                      onClick={() => deleteAskMsg(i)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>
              ))}
              {askBusy && <div className="text-xs text-muted-foreground">Thinking…</div>}
            </div>
            <div className="pt-2 flex gap-2 items-end relative">
              <textarea
                className="input flex-1"
                style={{ minHeight: 40, resize: "none" }}
                placeholder="Ask about this text…  (type / for saved prompts)"
                value={askInput}
                onChange={(e) => onAskInputChange(e.target.value)}
                onKeyDown={onAskKeyDown}
                onBlur={() => setTimeout(() => setShowPromptMenu(false), 150)}
              />
              {showPromptMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-1 z-20 rounded-lg border bg-popover shadow-lg max-h-56 overflow-y-auto">
                  {filteredPrompts.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {savedPrompts.length === 0
                        ? "No saved prompts — add them in Settings → LLM → Saved prompts"
                        : "No prompts match “/" + promptQuery + "”"}
                    </div>
                  ) : (
                    filteredPrompts.map((p, i) => (
                      <button
                        key={p.id}
                        className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 ${
                          i === promptHi ? "bg-accent" : ""
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyPrompt(p);
                        }}
                        onMouseEnter={() => setPromptHi(i)}
                      >
                        <span className="text-[13px] font-medium">{p.name}</span>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {p.content.trim() ? p.content.trim().slice(0, 70) : "(empty)"}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              <button
                className="btn btn-primary"
                onClick={askSend}
                disabled={askBusy || !askInput.trim()}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function buildAskSystem(data?: WordPanelData | null): string {
  const article = (data?.article || "").slice(0, 4000);
  const sel = data?.text || "";
  let sys =
    "You are a friendly language tutor. The user is reading an English text and may ask about vocabulary, grammar, meaning, or discussion. ";
  if (article) sys += `Article context:\n"""\n${article}\n"""\n`;
  if (sel && sel !== article)
    sys += `The user's current selection / focus:\n"""\n${sel}\n"""\n`;
  sys +=
    "Answer clearly and concisely. If the question is about a specific word or phrase, explain it in context.";
  return sys;
}

function bandColor(b: "1k" | "3k" | "5k" | "6k" | "above") {
  return { "1k": "#16a34a", "3k": "#65a30d", "5k": "#eab308", "6k": "#dc2626", "above": "#9ca3af" }[b];
}
function bandRgb(b: "1k" | "3k" | "5k" | "6k" | "above") {
  return { "1k": "22,163,74", "3k": "101,163,13", "5k": "234,179,8", "6k": "220,38,38", "above": "156,163,175" }[b];
}
