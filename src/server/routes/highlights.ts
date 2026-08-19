import express from "express";
import { getDb, genId } from "../db.js";

// 原文划词高亮（8 色）+ 摘录批注。
// 每条 highlight 绑定一个资源（resourceId），text 为划词原文，color 为色键，
// note 为批注（可后续补充）。心得（insight）沿用 notes 表（resourceId 关联）。
export function registerHighlightsRoutes(app: express.Express, ctx: { now: () => number }) {
  const { now } = ctx;

  // 列表：全部（按时间倒序）或按资源过滤 ?resourceId=
  app.get("/api/highlights", (req, res) => {
    const rid = req.query.resourceId ? String(req.query.resourceId) : null;
    const rows = rid
      ? getDb()
          .prepare("SELECT * FROM highlights WHERE resourceId=? ORDER BY createdAt DESC")
          .all(rid)
      : getDb().prepare("SELECT * FROM highlights ORDER BY createdAt DESC").all();
    res.json(rows);
  });

  app.post("/api/highlights", (req, res) => {
    const b = req.body || {};
    if (!b.resourceId || !b.text) {
      return res.status(400).json({ error: "resourceId and text are required" });
    }
    const row = {
      id: genId(),
      resourceId: String(b.resourceId),
      text: String(b.text),
      color: String(b.color || "yellow"),
      note: String(b.note || ""),
      createdAt: now(),
    };
    getDb()
      .prepare(
        `INSERT INTO highlights(id,resourceId,text,color,note,createdAt)
         VALUES(@id,@resourceId,@text,@color,@note,@createdAt)`
      )
      .run(row);
    res.json(row);
  });

  app.put("/api/highlights/:id", (req, res) => {
    const b = req.body || {};
    // 只更新显式提供的字段（如仅改批注 note，不触碰 text/color）
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of ["text", "color", "note"] as const) {
      if (b[key] !== undefined) {
        sets.push(`${key}=?`);
        params.push(String(b[key]));
      }
    }
    sets.push("createdAt=?");
    params.push(now());
    params.push(req.params.id);
    getDb().prepare(`UPDATE highlights SET ${sets.join(", ")} WHERE id=?`).run(...params);
    res.json({ ok: true });
  });

  app.delete("/api/highlights/:id", (req, res) => {
    getDb().prepare("DELETE FROM highlights WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
}
