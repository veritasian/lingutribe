// Settings → LLM tab: default engine form, saved-config history (draggable),
// grammar prompt editor, and the named "Saved prompts" manager.
import { useState } from "react";
import { api, type Settings } from "../../api";
import { IconEdit, IconTrash } from "../../components/Icon";

// Mirror of the server DEFAULT_GRAMMAR_PROMPT — used for placeholder + live
// preview. Keep in sync with src/server. (Word lookup now uses the offline
// MDict engine, so there is no "words" prompt to edit here.)
const DEFAULT_GRAMMAR_PROMPT = `I speak {N}. You're my {L} coach. I'll provide {L} text, you'll help me analyze the sentence structure, grammar, and vocabulary/phrases, and provide a detailed explanation of the text. Please return the results in the following format (but in {N}):

### Sentence Structure
(Explain each element of the sentence)

### Grammar
(Explain the grammar of the sentence)

### Vocabulary/Phrases
(Explain the key vocabulary and phrases used)`;

export default function LlmSection({
  settings,
  patchSettings,
  savedCat,
  onSaved,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  savedCat: string | null;
  onSaved: () => void;
}) {
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestOk, setLlmTestOk] = useState<boolean | null>(null);
  const [dragLlmIdx, setDragLlmIdx] = useState<number | null>(null);
  const [overLlmIdx, setOverLlmIdx] = useState<number | null>(null);
  // Saved-prompt manager (named prompt history)
  const [spName, setSpName] = useState("");
  const [spContent, setSpContent] = useState("");
  const [spMsg, setSpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [grammarSaved, setGrammarSaved] = useState(false);

  const e = settings.engines;
  const prompts = settings.prompts ?? { grammar: "" };
  const history = settings.llmHistory ?? [];
  const L = settings.languages.learning;
  const N = settings.languages.native;
  const effGrammar = (prompts.grammar.trim() ? prompts.grammar : DEFAULT_GRAMMAR_PROMPT)
    .replaceAll("{L}", L)
    .replaceAll("{N}", N);

  // LLM "Confirm": persist the whole settings (engine + prompts) and append a
  // history record so saved configurations survive a reload.
  async function confirmLlm() {
    const llm = settings.engines.llm;
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      engine: llm.engine,
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKey: llm.apiKey || "",
    };
    const history2 = [entry, ...(settings.llmHistory || [])].slice(0, 50);
    // Newest config is prepended → it becomes the default (first = default).
    const next: Settings = { ...settings, llmHistory: history2, defaultLlmId: entry.id };
    patchSettings(next);
    await api.saveSettings(next);
    onSaved();
  }

  async function testLlm() {
    setLlmTesting(true);
    setLlmTestOk(null);
    try {
      // Test the config currently shown in the form (what the user sees),
      // not the saved default — so "what you see is what is tested".
      await api.testLlm(e.llm);
      setLlmTestOk(true);
    } catch {
      setLlmTestOk(false);
    } finally {
      setLlmTesting(false);
    }
  }

  function deleteLlmHistory(id: number) {
    const arr = (settings.llmHistory || []).filter((h) => h.id !== id);
    const next = { ...settings, llmHistory: arr, defaultLlmId: arr[0]?.id };
    patchSettings(next);
    api.saveSettings(next);
  }

  // Reorder a saved-config list by drag-and-drop. After a move, the item now
  // at index 0 becomes the default automatically.
  function reorderLlm(from: number, to: number) {
    const arr = [...(settings.llmHistory || [])];
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const next: Settings = { ...settings, llmHistory: arr, defaultLlmId: arr[0]?.id };
    patchSettings(next);
    api.saveSettings(next);
  }

  // Saved-prompt manager: persist named prompts under settings.prompts.list.
  function savePrompt() {
    const name = spName.trim();
    const content = spContent;
    if (!name) {
      setSpMsg({ ok: false, text: "Please enter a name for the prompt." });
      return;
    }
    const id =
      "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const list = [...(settings.prompts?.list || [])];
    list.unshift({ id, name, content, createdAt: Date.now() });
    const next: Settings = {
      ...settings,
      prompts: { ...(settings.prompts || { grammar: "" }), list },
    };
    patchSettings(next);
    api.saveSettings(next);
    setSpMsg({ ok: true, text: `Saved “${name}” ✓` });
    setTimeout(() => setSpMsg(null), 2000);
    setSpName("");
    setSpContent("");
  }
  function deletePrompt(id: string) {
    const list = (settings.prompts?.list || []).filter((p) => p.id !== id);
    const next: Settings = {
      ...settings,
      prompts: { ...(settings.prompts || { grammar: "" }), list },
    };
    patchSettings(next);
    api.saveSettings(next);
  }
  function loadPrompt(id: string) {
    const p = (settings?.prompts?.list || []).find((x) => x.id === id);
    if (!p) return;
    setSpName(p.name);
    setSpContent(p.content);
    setSpMsg(null);
  }

  return (
    <>
      <section className="note-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          LLM (default engine)
        </h2>
        <select
          className="select"
          value={e.llm.engine}
          onChange={(v) =>
            patchSettings({ engines: { ...e, llm: { ...e.llm, engine: v.target.value } } })
          }
        >
          <option value="ollama">Ollama (local)</option>
          <option value="openai">OpenAI-compatible</option>
        </select>
        <input
          className="input"
          placeholder="Base URL (e.g. http://localhost:11434/v1)"
          value={e.llm.baseUrl}
          onChange={(v) =>
            patchSettings({
              engines: { ...e, llm: { ...e.llm, baseUrl: v.target.value } },
            })
          }
        />
        <input
          className="input"
          placeholder="Model (e.g. qwen3:0.6b)"
          value={e.llm.model}
          onChange={(v) =>
            patchSettings({ engines: { ...e, llm: { ...e.llm, model: v.target.value } } })
          }
        />
        <input
          className="input"
          placeholder="API key (optional)"
          value={e.llm.apiKey || ""}
          onChange={(v) =>
            patchSettings({
              engines: { ...e, llm: { ...e.llm, apiKey: v.target.value } },
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Default engine for explanations, translations and word practice. Runs locally via
          Ollama.
        </p>
        <div className="flex items-center gap-2">
          <button className="btn btn-primary" onClick={confirmLlm}>
            Confirm
          </button>
          <button className="btn btn-secondary" disabled={llmTesting} onClick={testLlm}>
            {llmTesting ? "Testing…" : "Test"}
          </button>
          {llmTestOk === true && <span className="text-xs text-green-500 font-medium">✓ Working</span>}
          {llmTestOk === false && <span className="text-xs text-red-500 font-medium">✗ Failed</span>}
          {savedCat === "llm" && (
            <span className="text-xs text-primary self-center">
              Saved ✓ (added to history)
            </span>
          )}
        </div>
      </section>

      {/* Persisted history — won't disappear on reload */}
      <section className="note-card p-4 space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Saved configurations
        </h2>
        {history.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No saved configurations yet. Click “Confirm” above to record one.
          </div>
        ) : (
          <ul className="space-y-1">
            {history.map((h, i) => (
              <li
                key={h.id}
                draggable
                onDragStart={(ev) => { setDragLlmIdx(i); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(i)); }}
                onDragOver={(ev) => { ev.preventDefault(); setOverLlmIdx(i); }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  if (dragLlmIdx !== null) reorderLlm(dragLlmIdx, i);
                  setDragLlmIdx(null);
                  setOverLlmIdx(null);
                }}
                onDragEnd={() => { setDragLlmIdx(null); setOverLlmIdx(null); }}
                className={`flex items-center justify-between gap-2 border rounded-lg px-3 py-2 text-xs cursor-pointer hover:bg-accent ${
                  dragLlmIdx === i ? "opacity-40" : ""
                } ${overLlmIdx === i && dragLlmIdx !== null && dragLlmIdx !== i ? "ring-2 ring-yellow-400" : ""}`}
                onClick={() =>
                  patchSettings({
                    engines: {
                      ...e,
                      llm: {
                        ...e.llm,
                        engine: h.engine,
                        baseUrl: h.baseUrl,
                        model: h.model,
                        // Only overwrite the key field when this config
                        // actually stored one. Legacy entries (no apiKey)
                        // keep the live field untouched.
                        // Each saved config owns its key. Load this
                        // config's key verbatim (empty string when it
                        // has none) so switching models never inherits
                        // another model's key from the live field.
                        apiKey: h.apiKey ?? "",
                      },
                    },
                  })
                }
              >
                <span className="text-muted-foreground/50 shrink-0 select-none cursor-grab" title="Drag to reorder">⠿</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    <span className="truncate">
                      {h.model} <span className="text-muted-foreground">· {h.engine}</span>
                    </span>
                    {i === 0 && (
                      <span className="ml-1 px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-600 text-[10px] font-semibold align-middle shrink-0">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground truncate">{h.baseUrl}</div>
                  <div className="text-muted-foreground/70 text-[10px] mt-0.5">
                    {h.apiKey ? "🔑 API key saved with this config" : "🔓 no API key (uses field below)"}
                  </div>
                </div>
                <div className="text-muted-foreground shrink-0">
                  {new Date(h.ts).toLocaleString()}
                </div>
                <button className="text-muted-foreground hover:text-red-500 shrink-0" onClick={(ev) => { ev.stopPropagation(); deleteLlmHistory(h.id); }} title="Delete">✕</button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Drag to reorder. The top config is the default used everywhere (explanations, word
          lookup, Ask AI); click any entry to load it into the form.
        </p>
      </section>

      {/* Custom prompts */}
      <section className="note-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Prompts</h2>
        <label className="block">
          <span className="text-xs text-muted-foreground">Grammar (sentence) prompt</span>
          <textarea
            className="textarea"
            rows={9}
            placeholder={DEFAULT_GRAMMAR_PROMPT}
            value={prompts.grammar}
            onChange={(v) => {
              setGrammarSaved(false);
              patchSettings({ prompts: { ...prompts, grammar: v.target.value } });
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Leave the field empty to use the built-in default. Use <code>{"{L}"}</code> for the
          learning language and <code>{"{N}"}</code> for the native language.
        </p>
        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary"
            onClick={() => {
              patchSettings({ prompts: { ...prompts, grammar: prompts.grammar } });
              setGrammarSaved(true);
            }}
          >
            Save prompt
          </button>
          {grammarSaved && (
            <span className="text-xs text-green-600">Saved ✓</span>
          )}
        </div>
        {grammarSaved && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Saved “Grammar” prompt:</span>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg border p-2 bg-secondary">
              {effGrammar}
            </pre>
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={confirmLlm}>
            Confirm
          </button>
        </div>
      </section>

      {/* Saved prompts (named history) */}
      <section className="note-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Saved prompts</h2>
        <p className="text-xs text-muted-foreground">
          Save reusable prompts by name. They appear below and can be inserted into the Ask
          AI box by typing <code>/</code>.
        </p>
        <label className="block">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className="input"
            value={spName}
            placeholder="e.g. Summarize, Explain simply…"
            onChange={(v) => {
              setSpName(v.target.value);
              setSpMsg(null);
            }}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Content</span>
          <textarea
            className="textarea"
            rows={6}
            value={spContent}
            placeholder="Write the prompt instructions here…"
            onChange={(v) => setSpContent(v.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={savePrompt}>
            Save prompt
          </button>
          {spMsg && (
            <span className={`text-xs ${spMsg.ok ? "text-green-600" : "text-red-500"}`}>
              {spMsg.text}
            </span>
          )}
        </div>

        {/* List of saved prompt names */}
        <div className="pt-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Saved ({ (settings?.prompts?.list || []).length })
          </div>
          {(settings?.prompts?.list || []).length === 0 ? (
            <div className="text-xs text-muted-foreground">No saved prompts yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {(settings?.prompts?.list || []).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{p.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {p.content.trim() ? p.content.trim().slice(0, 80) : "(empty)"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="icon-btn"
                      title="Load into editor"
                      aria-label="Load prompt"
                      onClick={() => loadPrompt(p.id)}
                    >
                      <IconEdit size={15} />
                    </button>
                    <button
                      className="icon-circle-btn"
                      title="Delete"
                      aria-label="Delete prompt"
                      onClick={() => deletePrompt(p.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
