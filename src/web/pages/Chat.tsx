// Chat area — replaces the old Notes page. Left: conversation list with a
// "New" button. Right: a ChatGPT-style chat driven by the local LLM engine
// (Settings → LLM). Conversations are persisted through the existing
// /api/notes endpoints (the note `body` stores the message JSON).

import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type Note } from "../api";
import { IconPlus, IconTrash, IconSend, IconChat, IconCopy } from "../components/Icon";

type Msg = { role: "user" | "assistant"; content: string };

/** Lightweight Markdown → HTML. */
function renderMd(raw: string): string {
  let html = raw
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Code blocks (```) before inline handling
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-secondary rounded-lg p-3 text-xs overflow-x-auto my-2"><code>$2</code></pre>');
  html = html.replace(/^###### (.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold mt-5 mb-2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-6 mb-3">$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-secondary text-xs">$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-primary underline">$1</a>');
  html = html.replace(/^(\s*)[-*] (.+)$/gm, '$1<li class="ml-5 list-disc">$2</li>');
  html = html.replace(/^(\s*)\d+\. (.+)$/gm, '$1<li class="ml-5 list-decimal">$2</li>');
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, "");
  html = html.replace(/<\/li><p>/g, "</li>");
  html = html.replace(/<\/p><li/g, "<li");
  html = html.replace(/<pre class="([^"]*)"><code>/g, '<pre class="$1"><code><p>');
  html = html.replace(/<\/code><\/pre>/g, '</p></code></pre>');
  return html;
}

function titleOf(msgs: Msg[]): string {
  const firstUser = msgs.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const t = firstUser.content.trim().replace(/\s+/g, " ");
  return t.length > 32 ? t.slice(0, 32) + "…" : t || "New chat";
}

export default function Chat() {
  const [convos, setConvos] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadConvos() {
    const list = await api.listNotes();
    setConvos(list);
    if (!activeId && list.length) {
      setActiveId(list[0].id);
      try {
        const body = JSON.parse(list[0].body || "[]");
        setMsgs(Array.isArray(body) ? body : []);
      } catch {
        setMsgs([]);
      }
    }
  }
  useEffect(() => {
    loadConvos();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  async function newChat() {
    const row = await api.createNote({ title: "New chat", body: "[]" });
    setConvos((c) => [row, ...c]);
    setActiveId(row.id);
    setMsgs([]);
    setError(null);
  }

  async function select(id: string) {
    const n = convos.find((c) => c.id === id);
    if (!n) return;
    setActiveId(id);
    setError(null);
    try {
      const body = JSON.parse(n.body || "[]");
      setMsgs(Array.isArray(body) ? body : []);
    } catch {
      setMsgs([]);
    }
  }

  async function persist(next: Msg[]) {
    if (!activeId) return;
    const title = titleOf(next);
    const body = JSON.stringify(next);
    await api.updateNote(activeId, { title, body });
    setConvos((c) =>
      c.map((n) => (n.id === activeId ? { ...n, title, body } : n))
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: Msg = { role: "user", content: text };
    const next = [...msgs, userMsg];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      // System prompt from the user's language settings (best-effort).
      let sys = "You are a helpful, concise assistant.";
      try {
        const s = await api.getSettings();
        const L = s.languages.learning || "en";
        const N = s.languages.native || "en";
        sys = `You are a helpful language-learning assistant. The user is learning ${L} and their native language is ${N}. Answer clearly and concisely.`;
      } catch {
        /* ignore — fall back to generic */
      }
      const payload: ChatMessage[] = [
        { role: "system", content: sys },
        ...next.map((m) => ({ role: m.role, content: m.content })),
      ];
      const r = await api.chat(payload);
      const assistantMsg: Msg = { role: "assistant", content: r.content };
      const finalMsgs = [...next, assistantMsg];
      setMsgs(finalMsgs);
      await persist(finalMsgs);
    } catch (e: any) {
      setError(e.message || "Chat failed");
      // keep the user's message; don't persist a failed turn
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.deleteNote(id);
    const remaining = convos.filter((c) => c.id !== id);
    setConvos(remaining);
    if (activeId === id) {
      if (remaining.length) {
        setActiveId(remaining[0].id);
        try {
          const body = JSON.parse(remaining[0].body || "[]");
          setMsgs(Array.isArray(body) ? body : []);
        } catch {
          setMsgs([]);
        }
      } else {
        setActiveId(null);
        setMsgs([]);
      }
    }
  }

  // Delete a single message within the current conversation.
  async function deleteMsg(i: number) {
    const next = msgs.filter((_, idx) => idx !== i);
    setMsgs(next);
    await persist(next);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div className="w-[280px] border-r flex flex-col shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="text-[15px] font-semibold">Chat</h2>
          <button className="btn btn-primary inline-flex items-center gap-1" onClick={newChat}>
            <IconPlus size={15} /> New
          </button>
        </div>
        <div className="scroll flex-1 p-2 space-y-1">
          {convos.length === 0 && (
            <div className="text-sm text-muted-foreground p-4">No conversations yet.</div>
          )}
          {convos.map((n) => (
            <div
              key={n.id}
              className={`sidebar-item justify-between ${activeId === n.id ? "active" : ""}`}
              onClick={() => select(n.id)}
            >
              <span className="truncate flex-1">{n.title}</span>
              <span
                className="text-muted-foreground text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(n.id);
                }}
                title="Delete"
              >
                <IconTrash size={14} />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-card">
        {!activeId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <IconChat size={48} />
            <div className="text-sm">Start a new conversation with your local LLM.</div>
            <button className="btn btn-primary inline-flex items-center gap-1" onClick={newChat}>
              <IconPlus size={15} /> New conversation
            </button>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
              <div className="mx-auto max-w-3xl w-full px-4 py-6 space-y-4">
                {msgs.length === 0 && !busy && (
                  <div className="text-sm text-muted-foreground text-center mt-10">
                    Say something to begin. Press Enter to send, Shift+Enter for a new line.
                  </div>
                )}
                {msgs.map((m, i) => (
                  <div
                    key={i}
                    className={`chat-row group ${m.role === "user" ? "chat-row-user" : "chat-row-assistant"}`}
                  >
                    {m.role === "assistant" && (
                      <div className="chat-avatar chat-avatar-bot">
                        <IconChat size={16} />
                      </div>
                    )}
                    <div className={`chat-bubble ${m.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
                      {m.role === "assistant"
                        ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                        : m.content}
                      {/* Copy / delete per message */}
                      <div className="mt-1.5 flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
                          onClick={() => deleteMsg(i)}
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                    </div>
                    {m.role === "user" && (
                      <div className="chat-avatar chat-avatar-user">You</div>
                    )}
                  </div>
                ))}
                {busy && (
                  <div className="chat-row chat-row-assistant">
                    <div className="chat-avatar chat-avatar-bot">
                      <IconChat size={16} />
                    </div>
                    <div className="chat-bubble chat-bubble-assistant">
                      <span className="chat-typing">
                        <span></span>
                        <span></span>
                        <span></span>
                      </span>
                    </div>
                  </div>
                )}
                {error && (
                  <div className="text-sm text-red-500 text-center">{error}</div>
                )}
              </div>
            </div>

            {/* Composer */}
            <div className="border-t px-4 py-3 shrink-0">
              <div className="mx-auto max-w-3xl w-full flex items-end gap-2">
                <textarea
                  className="textarea chat-input"
                  rows={1}
                  placeholder="Message your LLM…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                />
                <button
                  className="btn btn-primary inline-flex items-center gap-1 shrink-0"
                  onClick={send}
                  disabled={busy || !input.trim()}
                >
                  <IconSend size={15} /> Send
                </button>
              </div>
              <div className="mx-auto max-w-3xl w-full mt-1 text-[10px] text-muted-foreground">
                Local LLM only · configure in Settings → LLM.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
