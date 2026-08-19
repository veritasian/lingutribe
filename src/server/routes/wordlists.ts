import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { getDb, genId, getLibraryPath } from "../db.js";

// 自定义单词表（四级/六级/考研/雅思…）：
//   - 词表本体存为纯文本：library/wordlists/<id>.txt（每行「词头 TAB 释义…」或纯词表）
//   - settings.customLists 只存元数据 [{ id, name, file, count }]
// 解析规则：
//   1. 编码：优先 UTF-8（去 BOM），失败回退 GB18030（兼容中文释义的 GBK 词表）
//   2. 跳过空行 / # 注释行
//   3. 词头 = 行首第一个 TAB 前内容；无 TAB 则第一个空白前；再取首个空白分词（丢弃行内音标 [..]）
//   4. 词头小写去重（保留首次出现的整行，含释义），写入文件
export function registerWordListsRoutes(app: express.Express, ctx: { readSettings: () => any; writeSettings: (s: any) => void; now: () => number }) {
  const { readSettings, writeSettings } = ctx;

  function wordlistsDir(): string {
    const d = path.join(getLibraryPath(), "wordlists");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function meta(): { id: string; name: string; file: string; count: number }[] {
    const s = readSettings();
    return Array.isArray(s.customLists) ? s.customLists : [];
  }

  function saveMeta(list: any[]) {
    const s = readSettings();
    writeSettings({ ...s, customLists: list });
  }

  /** 解码文本：UTF-8（去 BOM）优先，失败回退 GB18030。 */
  function decode(buf: Buffer): string {
    const utf8 = buf.toString("utf8").replace(/^\uFEFF/, "");
    // 校验是否为合法 UTF-8（GBK 中文按 utf8 解码会产生 U+FFFD）
    if (!utf8.includes("\uFFFD")) return utf8;
    return new TextDecoder("gb18030").decode(buf).replace(/^\uFEFF/, "");
  }

  /** 从一行文本提取规范化词头（小写、去音标等）。返回 null 表示跳过。 */
  function headwordOf(line: string): string | null {
    let head = line.split("\t")[0] || "";
    if (!head.trim()) {
      head = line.trim().split(/\s+/)[0] || "";
    }
    // 丢弃词头行内可能携带的音标/括号注释（如 "abandon [ə'bændən]"）
    head = head.replace(/^[^a-zA-Z]+|[\[\(].*$/, "").trim();
    if (!head) return null;
    const norm = head.toLowerCase();
    if (!/^[a-z']+$/.test(norm)) return null;
    return norm;
  }

  // 列表（元数据，count 在导入时已计算）
  app.get("/api/wordlists", (_req, res) => {
    res.json(meta());
  });

  // 某词表的全部词头（小写，供客户端匹配）
  app.get("/api/wordlists/:id/words", (req, res) => {
    const m = meta().find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "word list not found" });
    const fp = path.join(wordlistsDir(), m.file);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "word list file missing" });
    const words: string[] = [];
    for (const line of decode(fs.readFileSync(fp)).split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const h = headwordOf(line);
      if (h) words.push(h);
    }
    res.json({ id: m.id, name: m.name, words });
  });

  // 导入：JSON { name, content }（粘贴）或 multipart（name + file 上传）
  // 文件用内存版 multer，便于读取 buffer 后统一解析。
  const fileUpload = multer({ storage: multer.memoryStorage() }).single("file");
  app.post("/api/wordlists/import", fileUpload, (req, res) => {
    try {
      const isMulti = req.is("multipart/form-data");
      let name = "";
      let text = "";
      if (isMulti) {
        name = String(req.body?.name || "").trim();
        text = decode((req as any).file?.buffer || Buffer.alloc(0));
      } else {
        name = String(req.body?.name || "").trim();
        text = String(req.body?.content || "");
      }
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!text.trim()) return res.status(400).json({ error: "词表内容为空" });

      // 解析 + 去重
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const h = headwordOf(line);
        if (!h || seen.has(h)) continue;
        seen.add(h);
        kept.push(line);
      }
      if (!kept.length) return res.status(400).json({ error: "未解析出任何有效单词（请确认每行格式：词头 TAB 释义 或 每行一词）" });

      const id = genId();
      const file = `${id}.txt`;
      fs.writeFileSync(path.join(wordlistsDir(), file), kept.join("\n") + "\n", "utf8");
      const row = { id, name, file, count: kept.length };
      saveMeta([...meta(), row]);
      res.json(row);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 重命名
  app.put("/api/wordlists/:id", (req, res) => {
    const list = meta();
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "word list not found" });
    if (req.body?.name !== undefined) list[idx].name = String(req.body.name).trim() || list[idx].name;
    saveMeta(list);
    res.json(list[idx]);
  });

  // 删除（删文件 + 元数据）
  app.delete("/api/wordlists/:id", (req, res) => {
    const list = meta();
    const m = list.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "word list not found" });
    try {
      fs.unlinkSync(path.join(wordlistsDir(), m.file));
    } catch {
      /* 文件可能已缺失，忽略 */
    }
    saveMeta(list.filter((x) => x.id !== req.params.id));
    res.json({ ok: true });
  });
}
