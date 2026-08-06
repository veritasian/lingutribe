import express from "express";
import { getDb, genId } from "../db.js";

export function registerNotesRoutes(app: express.Express, ctx: { db: ReturnType<typeof getDb>; now: () => number }) {
  const { db, now } = ctx;
// --- Notes ---
app.get("/api/notes", (_req, res) => {
  res.json(db.prepare("SELECT * FROM notes ORDER BY updatedAt DESC").all());
});
app.post("/api/notes", (req, res) => {
  const b = req.body;
  const row = {
    id: genId(),
    title: b.title || "Untitled",
    body: b.body || "",
    resourceId: b.resourceId || null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(
    `INSERT INTO notes(id,title,body,resourceId,createdAt,updatedAt)
     VALUES(@id,@title,@body,@resourceId,@createdAt,@updatedAt)`
  ).run(row);
  res.json(row);
});
app.put("/api/notes/:id", (req, res) => {
  const b = req.body;
  db.prepare(
    "UPDATE notes SET title=?, body=?, resourceId=?, updatedAt=? WHERE id=?"
  ).run(b.title, b.body, b.resourceId ?? null, now(), req.params.id);
  res.json({ ok: true });
});
app.delete("/api/notes/:id", (req, res) => {
  db.prepare("DELETE FROM notes WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
}
