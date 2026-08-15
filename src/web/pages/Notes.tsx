import { useEffect, useState } from "react";
import { api, type Note } from "../api";

export default function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [active, setActive] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  async function load() {
    setNotes(await api.listNotes());
  }
  useEffect(() => {
    load();
  }, []);

  function newNote() {
    setActive(null);
    setTitle("");
    setBody("");
  }

  async function save() {
    const t = title.trim() || "Untitled";
    if (active) {
      await api.updateNote(active.id, { title: t, body });
      setActive({ ...active, title: t, body });
    } else {
      const row = await api.createNote({ title: t, body });
      setActive(row);
    }
    await load();
  }

  async function remove(id: string) {
    await api.deleteNote(id);
    if (active?.id === id) newNote();
    await load();
  }

  function open(n: Note) {
    setActive(n);
    setTitle(n.title);
    setBody(n.body);
  }

  return (
    <div className="flex h-full">
      <div className="w-[300px] border-r flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="text-[15px] font-semibold">Notes</h2>
          <button className="btn btn-primary" onClick={newNote}>
            + New
          </button>
        </div>
        <div className="scroll flex-1 p-2 space-y-1">
          {notes.length === 0 && <div className="text-sm text-muted-foreground p-4">No notes yet.</div>}
          {notes.map((n) => (
            <div key={n.id} className={`sidebar-item ${active?.id === n.id ? "active" : ""}`} onClick={() => open(n)}>
              <span className="truncate flex-1">{n.title}</span>
              <span className="text-muted-foreground text-xs" onClick={(e) => { e.stopPropagation(); remove(n.id); }}>
                ✕
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 scroll p-6 max-w-3xl">
        <div className="flex items-center gap-2 mb-3">
          <input
            className="input text-lg font-semibold flex-1"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {active && (
            <button
              className="btn btn-ghost px-3"
              title="Delete note"
              aria-label="Delete note"
              onClick={() => remove(active.id)}
            >
              ✕
            </button>
          )}
        </div>
        <textarea
          className="textarea"
          rows={20}
          placeholder="Write your notes in Markdown…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="mt-3">
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
