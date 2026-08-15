// Inline note editor shown below the audio/video/reading content. Loads the
// note attached to a given resourceId (creating one on first open), and
// auto-saves (debounced) so edits sync straight into the Notes list.
//
// Hardening vs. the first version:
//  - pending edits are flushed on unmount/close (no silent data loss)
//  - typing during the initial load is never overwritten by the fetch
//  - rapid remounts can't create duplicate notes for the same resource
//  - autosave failures are surfaced instead of becoming unhandled rejections
import { useEffect, useRef, useState } from "react";
import { api, type Note } from "../api";

// Dedupe concurrent createNote calls for one resource across rapid remounts.
const creating = new Map<string, Promise<Note>>();

export default function NoteEditor({
  resourceId,
  autoTitle,
  onClose,
}: {
  resourceId: string;
  /** Default title used when a note is first created for this resource. */
  autoTitle?: string;
  onClose?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = useRef(false);
  const userTyped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest known (noteId, title, body) so an unmount can flush reliably.
  const latest = useRef({ noteId: null as string | null, title: "", body: "" });

  async function flush() {
    const l = latest.current;
    if (!l.noteId) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      await api.updateNote(l.noteId, { title: l.title.trim() || "Untitled", body: l.body });
    } catch {
      /* best-effort on unmount — nothing to update the UI with */
    }
  }

  // Load the existing note for this resource, or create one.
  useEffect(() => {
    let cancel = false;
    loaded.current = false;
    userTyped.current = false;
    setNoteId(null);
    setError(null);
    (async () => {
      try {
        const rows = await api.listNotes(resourceId);
        if (cancel) return;
        let n: Note;
        if (rows.length) {
          n = rows[0];
        } else {
          let p = creating.get(resourceId);
          if (!p) {
            p = api
              .createNote({ title: autoTitle?.trim() || "Untitled", body: "", resourceId })
              .finally(() => creating.delete(resourceId));
            creating.set(resourceId, p);
          }
          n = await p;
        }
        if (cancel) return;
        setNoteId(n.id);
        latest.current = { noteId: n.id, title: n.title, body: n.body };
        // Don't clobber what the user may already have typed while loading.
        if (!userTyped.current) {
          setTitle(n.title);
          setBody(n.body);
        }
        loaded.current = true;
      } catch (e: any) {
        if (!cancel) setError("Failed to open note: " + (e.message || ""));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [resourceId, autoTitle]);

  // Debounced auto-save after the initial load.
  useEffect(() => {
    if (!loaded.current || !noteId) return;
    latest.current = { noteId, title, body };
    setSaving(true);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      try {
        await api.updateNote(noteId, { title: title.trim() || "Untitled", body });
      } catch (e: any) {
        setError("Auto-save failed: " + (e.message || ""));
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [title, body, noteId]);

  // Flush any pending debounce when the editor unmounts/close.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  const onTitle = (v: string) => {
    userTyped.current = true;
    setTitle(v);
  };
  const onBody = (v: string) => {
    userTyped.current = true;
    setBody(v);
  };

  return (
    <div className="border-t shrink-0 bg-card">
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <span className="text-sm font-medium">Note</span>
        <span className="text-[11px] text-muted-foreground">
          {error ? "Save failed" : saving ? "Saving…" : "Auto-saved"}
        </span>
        {error && (
          <button
            className="text-[11px] text-red-500 underline"
            onClick={() => {
              setError(null);
              loaded.current && noteId &&
                api.updateNote(noteId, { title: title.trim() || "Untitled", body });
            }}
            title="Retry save"
          >
            Retry
          </button>
        )}
        {onClose && (
          <button
            className="icon-btn ml-auto"
            onClick={onClose}
            title="Close note"
            aria-label="Close note"
          >
            ✕
          </button>
        )}
      </div>
      <div className="p-4 max-h-[42vh] overflow-auto space-y-2">
        <input
          className="input w-full"
          placeholder="Title"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
        />
        <textarea
          className="textarea w-full"
          rows={8}
          placeholder="Write your notes in Markdown…"
          value={body}
          onChange={(e) => onBody(e.target.value)}
        />
      </div>
    </div>
  );
}
