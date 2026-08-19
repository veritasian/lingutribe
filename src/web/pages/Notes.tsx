// 我的笔记 —— 聚合视图：
//   本章心得（resources 关联笔记） + 随想（无资源笔记） + 划词摘录（highlights + 批注）
// 支持全选 / 手动多选 + 一键导出 Markdown（本地 Blob 下载，无云端）。
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Note, type Highlight, HIGHLIGHT_COLORS, type Resource } from "../api";
import { IconDownload, IconTrash } from "../components/Icon";

const fmt = (ts: number) => new Date(ts).toLocaleString("zh-CN");
const pad = (n: number) => String(n).padStart(2, "0");
const nKey = (id: string) => `n:${id}`;
const hKey = (id: string) => `h:${id}`;

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  async function load() {
    const [ns, hs, rs] = await Promise.all([
      api.listNotes(),
      api.listHighlights(),
      api.listResources(),
    ]);
    setNotes(ns);
    setHighlights(hs);
    setResources(rs);
  }
  useEffect(() => {
    load();
  }, []);

  const resName = (id?: string) => resources.find((r) => r.id === id)?.name || "";

  async function removeNoteItem(id: string) {
    await api.deleteNote(id);
    setNotes(notes.filter((n) => n.id !== id));
    setSelected((p) => {
      const s = new Set(p);
      s.delete(nKey(id));
      return s;
    });
  }
  async function removeHighlightItem(id: string) {
    await api.deleteHighlight(id);
    setHighlights(highlights.filter((h) => h.id !== id));
    setSelected((p) => {
      const s = new Set(p);
      s.delete(hKey(id));
      return s;
    });
  }

  // 分类：心得 = 带 resourceId 的笔记；随想 = 无资源笔记
  const insightNotes = notes.filter((n) => n.resourceId);
  const generalNotes = notes.filter((n) => !n.resourceId);

  // 选择逻辑
  const allIds = useMemo(
    () => [...notes.map((n) => nKey(n.id)), ...highlights.map((h) => hKey(h.id))],
    [notes, highlights]
  );
  const allSelected = allIds.length > 0 && allIds.every((k) => selected.has(k));
  const someSelected = selected.size > 0 && !allSelected;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }
  function toggle(key: string) {
    setSelected((p) => {
      const s = new Set(p);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });
  }

  // 导出 Markdown
  function exportMd() {
    if (selected.size === 0) return;
    const selNotes = notes.filter((n) => selected.has(nKey(n.id)));
    const selHls = highlights.filter((h) => selected.has(hKey(h.id)));
    const q = (s: string) => s.split("\n").join("\n> ");
    const L: string[] = [];
    L.push("# My Notes · Lingutribe", "");
    L.push(`Exported: ${fmt(Date.now())} · ${selNotes.length + selHls.length} items`, "");
    const insights = selNotes.filter((n) => n.resourceId);
    const generals = selNotes.filter((n) => !n.resourceId);
    if (insights.length) {
      L.push("## 本章心得", "");
      for (const n of insights) {
        const name = resName(n.resourceId);
        L.push(name ? `### ${name}` : "### 心得", "");
        L.push(`> ${q(n.body || n.title || "")}`, "", `> *${fmt(n.createdAt)}*`, "");
      }
    }
    if (generals.length) {
      L.push("## 随想", "");
      for (const n of generals) {
        L.push(`> ${q(n.body || n.title || "")}`, "", `> *${fmt(n.createdAt)}*`, "");
      }
    }
    if (selHls.length) {
      L.push("## 划词摘录", "");
      for (const h of selHls) {
        const name = resName(h.resourceId);
        L.push(name ? `### ${name}` : "### 摘录", "");
        L.push(`> ${q(h.text)}`);
        if (h.note) L.push("", `> **批注：** ${q(h.note)}`);
        L.push("", `> *${fmt(h.createdAt)}*`, "");
      }
    }
    const d = new Date();
    const filename = `lingutribe-notes-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
    triggerDownload(filename, L.join("\n"));
  }

  const colorBg: Record<string, string> = Object.fromEntries(
    HIGHLIGHT_COLORS.map((c) => [c.key, c.bg])
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b shrink-0">
        <h2 className="text-[15px] font-semibold">Notes</h2>
        <p className="text-xs text-muted-foreground">
          心得 · 随想 · 划词摘录（含批注），勾选后一键导出 Markdown
        </p>
      </div>

      <div className="flex-1 min-h-0 scroll p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {/* Export toolbar */}
          <div className="flex items-center justify-between rounded-lg border px-4 py-2.5 bg-card">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4"
              />
              全选（已选 {selected.size} 项）
            </label>
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              disabled={selected.size === 0}
              onClick={exportMd}
              title="将勾选内容导出为 Markdown 文件"
            >
              <IconDownload size={15} /> 导出 MD
            </button>
          </div>

          {notes.length === 0 && highlights.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              还没有笔记。在音频/视频/阅读页划词高亮、写心得后，会出现在这里。
            </p>
          )}

          {/* 本章心得 */}
          {insightNotes.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                本章心得（{insightNotes.length}）
              </div>
              <div className="space-y-2">
                {insightNotes.map((n) => {
                  const key = nKey(n.id);
                  const checked = selected.has(key);
                  const name = resName(n.resourceId);
                  return (
                    <div
                      key={n.id}
                      className={`rounded-lg border p-3.5 ${checked ? "border-primary" : "border-border"} ${
                        checked ? "bg-primary/5" : "bg-card"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(key)}
                          className="mt-1 h-4 w-4"
                          aria-label="选择此心得"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] text-muted-foreground mb-1">
                            {name || "（无资源）"} · {fmt(n.createdAt)}
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">
                            {n.body || n.title}
                          </p>
                          <div className="mt-2 text-right">
                            <button
                              className="text-muted-foreground hover:text-red-500"
                              onClick={() => removeNoteItem(n.id)}
                              title="删除"
                            >
                              <IconTrash size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 随想 */}
          {generalNotes.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                随想（{generalNotes.length}）
              </div>
              <div className="space-y-2">
                {generalNotes.map((n) => {
                  const key = nKey(n.id);
                  const checked = selected.has(key);
                  return (
                    <div
                      key={n.id}
                      className={`rounded-lg border p-3.5 ${checked ? "border-primary bg-primary/5" : "border-border bg-card"}`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(key)}
                          className="mt-1 h-4 w-4"
                          aria-label="选择此随想"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] text-muted-foreground mb-1">{fmt(n.createdAt)}</div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">{n.body || n.title}</p>
                          <div className="mt-2 text-right">
                            <button
                              className="text-muted-foreground hover:text-red-500"
                              onClick={() => removeNoteItem(n.id)}
                              title="删除"
                            >
                              <IconTrash size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 划词摘录 */}
          {highlights.length > 0 && (
            <section>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                划词摘录（{highlights.length}）
              </div>
              <div className="space-y-2">
                {highlights.map((h) => {
                  const key = hKey(h.id);
                  const checked = selected.has(key);
                  const name = resName(h.resourceId);
                  return (
                    <div
                      key={h.id}
                      className={`rounded-lg border p-3.5 ${checked ? "border-primary bg-primary/5" : "border-border bg-card"}`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(key)}
                          className="mt-1 h-4 w-4"
                          aria-label="选择此摘录"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-3 w-3 shrink-0 rounded-full"
                              style={{ background: colorBg[h.color] || "#eab308" }}
                            />
                            <span className="text-[11px] text-muted-foreground">
                              {name || "（无资源）"} · {fmt(h.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm leading-relaxed mt-1">{h.text}</p>
                          {h.note && (
                            <p className="mt-1.5 text-xs text-muted-foreground border-l-2 pl-2 border-primary/40">
                              {h.note}
                            </p>
                          )}
                          <div className="mt-2 text-right">
                            <button
                              className="text-muted-foreground hover:text-red-500"
                              onClick={() => removeHighlightItem(h.id)}
                              title="删除"
                            >
                              <IconTrash size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
