import express from "express";
import { getDb, genId } from "../db.js";

export function registerWordsRoutes(app: express.Express, ctx: { db: ReturnType<typeof getDb>; now: () => number }) {
  const { db, now } = ctx;
// --- Words ---
app.get("/api/words", (_req, res) => {
  res.json(db.prepare("SELECT * FROM words ORDER BY createdAt DESC").all());
});
app.post("/api/words", (req, res) => {
  const b = req.body;
  const row = {
    id: genId(),
    term: b.term,
    phonetics: b.phonetics || "",
    meaning: b.meaning || "",
    example: b.example || "",
    level: 0,
    reviewedAt: null,
    createdAt: now(),
  };
  db.prepare(
    `INSERT INTO words(id,term,phonetics,meaning,example,level,reviewedAt,createdAt)
     VALUES(@id,@term,@phonetics,@meaning,@example,@level,@reviewedAt,@createdAt)`
  ).run(row);
  res.json(row);
});
app.put("/api/words/:id", (req, res) => {
  const b = req.body;
  db.prepare(
    "UPDATE words SET term=?, phonetics=?, meaning=?, example=?, level=?, reviewedAt=? WHERE id=?"
  ).run(
    b.term,
    b.phonetics ?? "",
    b.meaning ?? "",
    b.example ?? "",
    b.level ?? 0,
    b.reviewedAt ?? null,
    req.params.id
  );
  res.json({ ok: true });
});
app.delete("/api/words/:id", (req, res) => {
  db.prepare("DELETE FROM words WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
}
