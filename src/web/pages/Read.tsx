import { useEffect, useRef, useState } from "react";
import { api, type Resource, type Highlight, HIGHLIGHT_COLORS } from "../api";
import VocabProfile from "../components/VocabProfile";
import WordPanel, { type WordPanelData } from "../components/WordPanel";
import { useCoca } from "../lib/coca";
import { renderMarkdown } from "../lib/markdown";
import { IconPlus, IconVolume, IconPause, IconCopy, IconChat, IconPlay, IconChevronLeft, IconChevronRight } from "../components/Icon";

/** Hex → rgba()，用于高亮 mark 背景。 */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Strip HTML tags for TTS. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Split text into sentences. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** Extract the word at the current selection from a contentEditable element. */
function wordAtClick(e: React.MouseEvent<HTMLDivElement>): string | null {
  const el = e.currentTarget;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  // Get click position via range
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!range || el !== range.commonAncestorContainer && !el.contains(range.commonAncestorContainer)) return null;
  // Expand to word boundaries
  const text = range.startContainer.textContent || "";
  let start = range.startOffset, end = range.endOffset;
  const wordRe = /\w/;
  while (start > 0 && wordRe.test(text[start - 1])) start--;
  while (end < text.length && wordRe.test(text[end])) end++;
  const word = text.slice(start, end).trim();
  // Only accept real words (2+ chars, alpha/')
  return /^[a-zA-Z']{2,}$/.test(word) ? word : null;
}

export default function Read() {
  const [items, setItems] = useState<Resource[]>([]);
  const [active, setActive] = useState<Resource | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [mode, setMode] = useState<"file" | "url">("file");
  const [urlInput, setUrlInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const coca = useCoca();
  const [tab, setTab] = useState<"content" | "layout">("content");
  const [panel, setPanel] = useState<WordPanelData | null>(null);
  // Floating selection toolbar (Copy / Ask AI / Read) anchored to the
  // selected text range.
  const [selMenu, setSelMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const selMenuRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sentIdx, setSentIdx] = useState(-1);
  const sentencesRef = useRef<string[]>([]);
  const [showAudio, setShowAudio] = useState(false);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dirty, setDirty] = useState(false);
  // ── 划词高亮（当前文章） ──
  const [hls, setHls] = useState<Highlight[]>([]);
  // 右栏 Note 列表刷新令牌
  const [hlRefresh, setHlRefresh] = useState(0);
  // 右栏面板宽度（可拖拽，与音频/视频页共享偏好）
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const w = Number(localStorage.getItem("lingo-panel-w"));
    return w && w >= 280 && w <= 640 ? w : 360;
  });
  useEffect(() => {
    localStorage.setItem("lingo-panel-w", String(panelWidth));
  }, [panelWidth]);
  // 左栏资源列表可折叠（同音频/视频页）
  const [listOpen, setListOpen] = useState(
    () => localStorage.getItem("lingo-read-list") !== "collapsed"
  );

  function toggleList() {
    setListOpen((v) => {
      const next = !v;
      localStorage.setItem("lingo-read-list", next ? "open" : "collapsed");
      return next;
    });
  }

  async function load() {
    setItems(await api.listResources().then((all) => all.filter((r) => r.type === "read")));
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const list = items.filter((r) => r.type === "read");
    if (list.length > 0 && !active) setActive(list[0]);
  }, [items, active]);

  // When active changes, set the article innerHTML
  useEffect(() => {
    if (active?.transcript && contentRef.current) {
      contentRef.current.innerHTML = renderMarkdown(active.transcript);
      setDirty(false);
    }
  }, [active?.id]);

  // 载入当前文章的高亮；打开时默认展开右栏 Note 页
  useEffect(() => {
    if (!active) return;
    setHls([]);
    api.listHighlights(active.id).then(setHls).catch(() => {});
    setPanel({
      text: "",
      context: "",
      isWord: false,
      defaultTab: "note",
      thread: active.id,
      article: active.transcript || "",
      title: active.name,
      refreshKey: hlRefresh,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // 把已存高亮应用到文章文本节点（mark 包裹，最长匹配优先）
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.querySelectorAll("mark[data-lingo-hl]").forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    if (!hls.length) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.parentElement?.closest("mark[data-lingo-hl], script, style")) continue;
      nodes.push(n);
    }
    const colorMap = new Map(hls.map((h) => [h.text, h.color]));
    const bgOf = (key: string) => {
      const c = HIGHLIGHT_COLORS.find((x) => x.key === key);
      return c ? hexToRgba(c.bg, 0.28) : "rgba(234,179,8,0.28)";
    };
    for (const node of nodes) {
      let rest = node.textContent || "";
      if (!rest) continue;
      const pieces: { text: string; color?: string }[] = [];
      let changed = false;
      while (rest.length) {
        let bestIdx = -1;
        let bestLen = 0;
        let bestColor: string | null = null;
        for (const [quote, color] of colorMap.entries()) {
          if (!quote) continue;
          const idx = rest.indexOf(quote);
          if (idx !== -1 && quote.length > bestLen) {
            bestIdx = idx;
            bestLen = quote.length;
            bestColor = color;
          }
        }
        if (bestIdx === -1 || bestLen === 0) {
          pieces.push({ text: rest });
          break;
        }
        if (bestIdx > 0) pieces.push({ text: rest.slice(0, bestIdx) });
        pieces.push({ text: rest.slice(bestIdx, bestIdx + bestLen), color: bestColor! });
        rest = rest.slice(bestIdx + bestLen);
        changed = true;
      }
      if (!changed) continue;
      const parent = node.parentNode;
      if (!parent) continue;
      for (const piece of pieces) {
        if (piece.color) {
          const mark = document.createElement("mark");
          mark.dataset.lingoHl = "1";
          mark.style.background = bgOf(piece.color);
          mark.style.borderRadius = "3px";
          mark.style.padding = "0 1px";
          mark.style.color = "inherit";
          mark.textContent = piece.text;
          parent.insertBefore(mark, node);
        } else {
          parent.insertBefore(document.createTextNode(piece.text), node);
        }
      }
      parent.removeChild(node);
    }
  }, [hls, active?.id]);

  async function createHighlight(text: string, color: string) {
    if (!active) return;
    try {
      await api.createHighlight({ resourceId: active.id, text, color, note: "" });
      setHls(await api.listHighlights(active.id));
      // 高亮后自动切到右栏 Note tab 并刷新摘录列表
      setHlRefresh((n) => n + 1);
      setPanel({
        text: "",
        context: "",
        isWord: false,
        defaultTab: "note",
        thread: active.id,
        article: active.transcript || "",
        title: active.name,
        refreshKey: hlRefresh + 1,
      });
    } catch {
      /* silent */
    }
  }

  function openNote(text: string) {
    if (!active) return;
    setPanel({
      text,
      context: text,
      isWord: false,
      defaultTab: "note",
      thread: active.id,
      article: active.transcript || "",
      title: active.name,
      refreshKey: hlRefresh,
    });
  }

  function closeSelMenu() {
    setSelMenu(null);
    window.getSelection()?.removeAllRanges();
  }

  // Clean up timers when the component unmounts (avoid leaked intervals).
  useEffect(() => () => {
    if (progressTimer.current) clearInterval(progressTimer.current);
    (CSS as any)?.highlights?.delete?.("lingo-sentence");
  }, []);

  // Highlight the sentence currently being read, using the CSS Custom
  // Highlight API (no DOM mutation — safe inside contentEditable).
  useEffect(() => {
    const H = (window as any).Highlight;
    const registry = (CSS as any)?.highlights;
    if (!H || !registry) return; // unsupported browser — progress bar still works
    registry.delete("lingo-sentence");
    if (!playing || sentIdx < 0 || !contentRef.current) return;
    const target = (sentencesRef.current[sentIdx] || "").trim();
    if (!target) return;
    // Collect text nodes + running offsets so we can map a string index → Range.
    const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; start: number }[] = [];
    let full = "";
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      nodes.push({ node: n, start: full.length });
      full += n.textContent || "";
    }
    const idx = full.indexOf(target);
    if (idx < 0) return; // markdown syntax stripped in render — skip gracefully
    const endIdx = idx + target.length;
    const findPos = (pos: number, isEnd: boolean) => {
      for (const { node, start } of nodes) {
        const len = (node.textContent || "").length;
        if (isEnd ? pos > start && pos <= start + len : pos >= start && pos < start + len)
          return { node, offset: pos - start };
      }
      return null;
    };
    const s = findPos(idx, false);
    const e = findPos(endIdx, true);
    if (!s || !e) return;
    try {
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      registry.set("lingo-sentence", new H(range));
      s.node.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch { /* range errors are non-fatal */ }
  }, [sentIdx, playing]);

  // Click word → open dictionary panel（划词/存在选区时跳过，避免误触查词）
  function onContentClick(e: React.MouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const word = wordAtClick(e);
    if (word) {
      setPanel({ text: word, context: word, isWord: true, rank: null, band: null });
    }
  }

  // Selection → floating toolbar (Copy / Ask AI / Highlight / Note / Read).
  function onContentMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelMenu(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) return;
    if (!contentRef.current?.contains(sel.anchorNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // Show the toolbar below the selection, flipped above when there's not
    // enough room at the bottom of the viewport.
    const W = 380, H = 34;
    let x = rect.left;
    if (x + W > window.innerWidth - 8) x = window.innerWidth - W - 8;
    if (x < 8) x = 8;
    let y = rect.bottom + 6;
    if (y + H > window.innerHeight - 8) y = Math.max(8, rect.top - H - 6);
    setSelMenu({ x, y, text });
  }

  // Close the floating toolbar on outside click / scroll / resize.
  useEffect(() => {
    if (!selMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (selMenuRef.current?.contains(e.target as Node)) return;
      setSelMenu(null);
    };
    const onScroll = () => setSelMenu(null);
    window.addEventListener("mousedown", onDocDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [selMenu]);

  async function onImport() {
    setBusy(true);
    setMsg("Importing…");
    try {
      const payload: any = { name: urlInput.trim() || undefined };
      if (mode === "file" && fileRef.current?.files?.[0]) {
        payload.file = fileRef.current.files[0];
      } else if (mode === "url" && urlInput.trim()) {
        payload.url = urlInput.trim();
      }
      const row = await api.importText(payload);
      setMsg(`Imported: ${row.name}`);
      setUrlInput("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
      setActive(row);
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function speak() {
    if (!active?.transcript) return;
    await speakText(active.transcript);
  }

  /** Read any text aloud (whole article, or the user's selected span). */
  async function speakText(text: string) {
    const clean = stripHtml(text).trim();
    if (!clean) return;
    setPlaying(true);
    setMsg("⏳ Synthesizing audio…");
    try {
      const s = await api.getSettings();
      let voice: string | undefined;
      const defaultCfg = s.defaultTtsId ? (s.ttsHistory || []).find((h) => h.id === s.defaultTtsId) : undefined;
      if (defaultCfg) {
        // Prefer the saved male/female voices (random pick); "voice" may be a
        // legacy value equal to the engine name — ignore that case.
        const cands = [defaultCfg.maleVoice, defaultCfg.femaleVoice].filter(Boolean) as string[];
        if (cands.length) voice = cands[Math.floor(Math.random() * cands.length)];
        else if (defaultCfg.voice && defaultCfg.voice !== defaultCfg.engine) voice = defaultCfg.voice;
      }
      if (!voice) {
        const mv = s.engines.tts.maleVoice;
        const fv = s.engines.tts.femaleVoice;
        if (mv && fv) voice = Math.random() < 0.5 ? mv : fv;
        else voice = mv || fv || undefined;
      }
      const textToSpeak = clean.slice(0, 5000);
      // Read-aloud is real-time: if "save TTS audio" is off, the server
      // returns a data URL (no file on disk); otherwise a /api/audio URL.
      const r = await api.synthesize(textToSpeak, { voice, save: false });
      setMsg("");
      if (audioRef.current) {
        audioRef.current.src = r.url || r.dataUrl || "";
        setShowAudio(true);
        sentencesRef.current = splitSentences(clean);
        setSentIdx(0);
        setProgress(0);
        startProgressTracking();
        await audioRef.current.play();
      } else {
        setMsg("❌ Audio element not ready — please try again.");
        setPlaying(false);
      }
    } catch (e: any) {
      setMsg(`❌ TTS error: ${e.message}`);
      setPlaying(false);
    }
  }

  function startProgressTracking() {
    stopProgressTracking();
    progressTimer.current = setInterval(() => {
      const el = audioRef.current;
      if (!el) return;
      const pct = el.duration ? (el.currentTime / el.duration) * 100 : 0;
      setProgress(pct);
      const total = sentencesRef.current.length;
      const idx = Math.min(total - 1, Math.floor((pct / 100) * total));
      setSentIdx(idx);
    }, 100);
  }

  function stopProgressTracking() {
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
  }

  function onAudioEnded() {
    stopProgressTracking();
    setPlaying(false);
    setSentIdx(-1);
    setProgress(0);
  }

  function stopPlayback() {
    stopProgressTracking();
    audioRef.current?.pause();
    setPlaying(false);
    setSentIdx(-1);
    setProgress(0);
  }

  async function remove(r: Resource) {
    await api.deleteResource(r.id);
    if (active?.id === r.id) setActive(null);
    await load();
  }

  return (
    <div className="flex h-full">
      {/* Left list — collapsible（同音频/视频页） */}
      {listOpen && (
      <div className="w-[300px] border-r flex flex-col shrink-0">
        <div className="px-4 py-3 border-b">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Read</h2>
            <button
              className="toggle-circle-btn"
              onClick={toggleList}
              title="Collapse list"
              aria-label="Collapse list"
            >
              <IconChevronLeft size={18} />
            </button>
          </div>
          <div className="flex items-center border rounded-md overflow-hidden mt-3 text-xs">
            <button className={`flex-1 px-2 py-1 ${mode === "file" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              onClick={() => setMode("file")}>Local file</button>
            <button className={`flex-1 px-2 py-1 ${mode === "url" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              onClick={() => setMode("url")}>URL</button>
          </div>
          {mode === "file" ? (
            <button className="btn btn-primary w-full mt-2 inline-flex items-center justify-center gap-1" disabled={busy}
              onClick={() => fileRef.current?.click()}>
              <IconPlus size={15} /> Add text file
            </button>
          ) : (
            <div className="mt-2 flex gap-1">
              <input className="input flex-1" style={{ padding: "6px 8px" }} placeholder="https://…"
                value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onImport()} />
              <button className="btn btn-primary" disabled={busy || !urlInput.trim()} onClick={onImport}>Import</button>
            </div>
          )}
          <input ref={fileRef} type="file" hidden onChange={onImport} accept=".txt,.md,.markdown,text/plain,text/markdown,text/*" />
        </div>
        <div className="scroll flex-1 p-2 space-y-1">
          {items.map((r) => (
            <div key={r.id} className={`sidebar-item ${active?.id === r.id ? "active" : ""}`} onClick={() => setActive(r)}>
              <span className="truncate flex-1">{r.name}{r.id === active?.id && dirty ? " *" : ""}</span>
              <button className="text-muted-foreground hover:text-red-500 text-xs" onClick={(e) => { e.stopPropagation(); remove(r); }}>✕</button>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Right content */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        {!listOpen && (
          <button
            className="toggle-circle-btn absolute top-3 left-3 z-10"
            onClick={toggleList}
            title="Expand list"
            aria-label="Expand list"
          >
            <IconChevronRight size={18} />
          </button>
        )}
        {msg && <div className="text-xs px-6 pt-4" style={{ color: msg.startsWith("❌") ? "#ef4444" : "hsl(var(--muted-foreground))" }}>{msg}</div>}
        {!active ? (
          <div className="p-6 text-muted-foreground">Import a text file or URL to get started.</div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Header + play button */}
            <div className="px-6 py-3 shrink-0 flex items-center justify-between gap-3 border-b">
              <h1 className="text-[15px] font-semibold truncate">{active.name}{dirty ? " ●" : ""}</h1>
              <div className="flex items-center gap-2">
                {playing ? (
                  <button className="btn btn-secondary inline-flex items-center gap-1"
                    onClick={stopPlayback} title="Stop">
                    <IconPause size={15} /> Stop
                  </button>
                ) : (
                  <button className="btn btn-secondary inline-flex items-center gap-1" disabled={playing}
                    onClick={speak} title="Read aloud with TTS">
                    <IconVolume size={15} /> Read aloud
                  </button>
                )}
              </div>
            </div>

            {/* Progress bar during playback */}
            {playing && (
              <div className="px-6 pt-2">
                <div className="h-1 rounded-full bg-secondary w-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-200" style={{ width: `${progress}%` }} />
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Sentence {sentIdx + 1} / {sentencesRef.current.length}
                </div>
              </div>
            )}

            {/* Tab bar — centered */}
            <div className="flex items-center justify-center border rounded-md overflow-hidden text-xs mt-3 mb-3 shrink-0 w-fit mx-auto">
              <button className={`px-3 py-1 ${tab === "content" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                onClick={() => setTab("content")}>Content</button>
              <button className={`px-3 py-1 ${tab === "layout" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                onClick={() => setTab("layout")}>Layout</button>
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-5">
              {/* Content tab — read-only article: select to copy / ask AI,
                  click a word to look it up. No editing. */}
              <div
                ref={contentRef}
                className="read-article max-w-3xl mx-auto leading-7 text-[15px] select-text prose rounded-lg p-1"
                style={{ display: tab === "content" ? "" : "none" }}
                onClick={onContentClick}
                onMouseUp={onContentMouseUp}
                title="Select text to copy, ask AI, or read aloud · click a word to look it up"
              />
              {/* Layout tab — data only, no content */}
              {tab === "layout" && (
                <div className="max-w-3xl mx-auto">
                  <VocabProfile coca={coca} words={[]} transcript={active.transcript || ""}
                    onWordClick={(w) => setPanel({ text: w, context: w, isWord: true, rank: null, band: null })} />
                </div>
              )}
            </div>

            {/* Audio player — always in DOM so the ref is valid when speaking */}
            <div className={`px-6 py-2 border-t shrink-0 ${showAudio ? "" : "hidden"}`}>
              <audio ref={audioRef} controls className="w-full h-8" onEnded={onAudioEnded} />
            </div>
          </div>
        )}
      </div>
      {/* Floating selection toolbar: Copy / Ask AI / Highlight / Note / Read */}
      {selMenu && (
        <div
          ref={selMenuRef}
          className="sel-toolbar"
          style={{ left: selMenu.x, top: selMenu.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="sel-toolbar-btn"
            title="Copy"
            onClick={async () => {
              const t = selMenu.text;
              closeSelMenu();
              try { await navigator.clipboard.writeText(t); } catch { /* ignore */ }
            }}
          >
            <IconCopy size={14} /> Copy
          </button>
          <button
            className="sel-toolbar-btn"
            title="Ask AI about the selected text"
            onClick={() => {
              const t = selMenu.text;
              closeSelMenu();
              if (active) {
                setPanel({
                  text: t,
                  context: t,
                  isWord: false,
                  defaultTab: "ask",
                  thread: active.id,
                  article: active.transcript || "",
                  title: active.name,
                });
              }
            }}
          >
            <IconChat size={14} /> Ask AI
          </button>
          <button
            className="sel-toolbar-btn"
            title="Highlight"
            onClick={() => {
              const t = selMenu.text;
              closeSelMenu();
              createHighlight(t, "green");
            }}
          >
            Highlight
          </button>
          <button
            className="sel-toolbar-btn"
            title="Add to notes"
            onClick={() => {
              const t = selMenu.text;
              closeSelMenu();
              openNote(t);
            }}
          >
            Note
          </button>
          <button
            className="sel-toolbar-btn"
            title="Read the selected text aloud"
            onClick={() => {
              const t = selMenu.text;
              closeSelMenu();
              speakText(t);
            }}
          >
            <IconPlay size={14} /> Read
          </button>
        </div>
      )}
      <WordPanel
        data={panel}
        onClose={() => setPanel(null)}
        width={panelWidth}
        onWidthChange={setPanelWidth}
      />
    </div>
  );
}
