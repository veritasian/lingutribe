import express from "express";
import { getDb, genId } from "../db.js";

export function registerChatRoutes(app: express.Express, ctx: { db: ReturnType<typeof getDb>; now: () => number }) {
  const { db, now } = ctx;
// --- Ask-AI chat history (persisted per thread, e.g. one thread per article) ---
app.get("/api/chat", (req, res) => {
  const thread = String(req.query.thread || "global");
  const messages = db
    .prepare("SELECT id, role, content, createdAt FROM chat_messages WHERE thread=? ORDER BY createdAt ASC")
    .all(thread);
  res.json({ messages });
});

app.post("/api/chat", (req, res) => {
  const { thread, role, content } = req.body || {};
  if (!thread || !role || !content) {
    return res.status(400).json({ error: "thread, role, content required" });
  }
  const row = { id: genId(), thread, role, content, createdAt: now() };
  db.prepare(
    "INSERT INTO chat_messages(id, thread, role, content, createdAt) VALUES(@id, @thread, @role, @content, @createdAt)"
  ).run(row);
  res.json(row);
});
}
