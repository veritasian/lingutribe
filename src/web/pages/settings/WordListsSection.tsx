// Settings → Word Lists tab：自定义单词表（四级/六级/考研/雅思…）。
// 词表本体存 library/wordlists/*.txt（每行「词头 TAB 释义…」或每行一词），
// 支持粘贴多行文本或上传 .txt；导入后自动去重并在 Layout 统计页提供过滤。
import { useEffect, useRef, useState } from "react";
import { api, type WordListMeta } from "../../api";

export default function WordListsSection() {
  const [lists, setLists] = useState<WordListMeta[]>([]);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setLists(await api.listWordLists());
    } catch (e: any) {
      setMsg(`加载失败: ${e.message}`);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function doImport(text: string) {
    const n = name.trim();
    if (!n) {
      setMsg("请先填写词表名称（如：雅思 / 四级 / 六级 / 考研）");
      return;
    }
    if (!text.trim()) {
      setMsg("词表内容为空");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const row = await api.importWordList(n, text);
      setMsg(`已导入「${row.name}」· ${row.count} 个单词 ✓`);
      setName("");
      setContent("");
      await load();
    } catch (e: any) {
      setMsg(`导入失败: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const n = name.trim() || f.name.replace(/\.(txt|md)$/i, "");
    setBusy(true);
    setMsg("");
    try {
      const row = await api.importWordListFile(n, f);
      setMsg(`已导入「${row.name}」· ${row.count} 个单词 ✓`);
      setName("");
      setContent("");
      await load();
    } catch (err: any) {
      setMsg(`导入失败: ${err.message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: string) {
    await api.deleteWordList(id);
    setLists(lists.filter((l) => l.id !== id));
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[15px] font-semibold">Word Lists</div>
        <div className="text-xs text-muted-foreground mt-1">
          自定义单词表（四级 / 六级 / 考研 / 雅思…）。导入后可在 Layout 统计页
          「Word list filter」中选择，只展示非该词表的内容（默认全部 = COCA）。
        </div>
      </div>

      {msg && <div className="text-xs text-primary/90">{msg}</div>}

      {/* 已有词表 */}
      <div className="space-y-1.5">
        {lists.length === 0 && (
          <div className="text-sm text-muted-foreground">还没有自定义词表。</div>
        )}
        {lists.map((l) => (
          <div key={l.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 bg-muted/30">
            <span className="text-sm font-medium flex-1 truncate">{l.name}</span>
            <span className="text-xs text-muted-foreground">{l.count} words</span>
            <button
              className="text-muted-foreground hover:text-red-500"
              title="Delete word list"
              aria-label={`Delete ${l.name}`}
              onClick={() => remove(l.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 新增 */}
      <div className="rounded-lg border p-4 space-y-2.5">
        <div className="text-sm font-medium">Add word list</div>
        <input
          className="input w-full"
          placeholder="名称（如：雅思 / 四级 / 六级 / 考研）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className="textarea w-full"
          rows={6}
          placeholder={"粘贴词表（每行：词头 TAB 释义… 或 每行一词）\n\n示例：\nabandon\tv. 放弃\nability\tn. 能力"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim() || !content.trim()}
            onClick={() => doImport(content)}
          >
            {busy ? "Importing…" : "粘贴导入"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            上传 .txt 文件
          </button>
          <input ref={fileRef} type="file" hidden accept=".txt,.md,.tsv,text/plain" onChange={onUpload} />
        </div>
        <div className="text-[10px] text-muted-foreground">
          支持 UTF-8 / GBK 编码；词头自动小写去重（保留首次出现的释义行）；空行与 # 注释行忽略。
        </div>
      </div>
    </div>
  );
}
