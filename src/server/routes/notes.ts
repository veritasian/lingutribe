import express from "express";
import { getDb, genId } from "../db.js";

export function registerNotesRoutes(app: express.Express, ctx: { now: () => number }) {
  const { now } = ctx;
// --- Notes ---
app.get("/api/notes", (req, res) => {
  // Sorted by creation ("install") time, newest first. Optional ?resourceId=
  // filter returns only the note(s) attached to a given resource.
  let rows = getDb().prepare("SELECT * FROM notes ORDER BY createdAt DESC").all();
  const rid = req.query.resourceId ? String(req.query.resourceId) : null;
  if (rid) rows = rows.filter((r: any) => r.resourceId === rid);
  res.json(rows);
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
  getDb().prepare(
    `INSERT INTO notes(id,title,body,resourceId,createdAt,updatedAt)
     VALUES(@id,@title,@body,@resourceId,@createdAt,@updatedAt)`
  ).run(row);
  res.json(row);
});
app.put("/api/notes/:id", (req, res) => {
  const b = req.body;
  // Preserve the existing resourceId when the update body doesn't include one
  // (the inline editor auto-saves with only {title, body}), so the note stays
  // linked to its resource.
  const existing = getDb().prepare("SELECT resourceId FROM notes WHERE id=?").get(req.params.id) as
    | { resourceId: string | null }
    | undefined;
  const resourceId =
    b.resourceId !== undefined ? b.resourceId ?? null : (existing?.resourceId ?? null);
  getDb().prepare(
    "UPDATE notes SET title=?, body=?, resourceId=?, updatedAt=? WHERE id=?"
  ).run(b.title, b.body, resourceId, now(), req.params.id);
  res.json({ ok: true });
});
app.delete("/api/notes/:id", (req, res) => {
  getDb().prepare("DELETE FROM notes WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
}
