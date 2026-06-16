import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkDownEditor, type ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import type { Note } from '../types/note';
import { useAutoSave, type Draft } from '../hooks/useAutoSave';
import { useTheme } from '../hooks/useTheme';
import './NoteEditor.css';

const STATUS_LABEL = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved to local disk',
} as const;

// The editing canvas for a single note. Luthor's markdown preset owns the body
// (uncontrolled — content is read imperatively at save time); a Marcellus title
// input sits above it. Both feed the debounced auto-save.
export default function NoteEditor({ note }: { note: Note }) {
  const { theme } = useTheme();
  const editorRef = useRef<ExtensiveEditorRef | null>(null);
  const [title, setTitle] = useState(note.title);
  // Mirror the title in a ref so the debounced save reads the live value, not a
  // value captured in the closure of the render that scheduled it.
  const titleRef = useRef(note.title);
  // The body Luthor is mounted with. Luthor is uncontrolled (defaultContent only
  // applies on mount), so adopting a remote body means remounting with a fresh
  // key — never patching the live DOM, which would hijack the caret.
  const [body, setBody] = useState(note.body);
  const [editorKey, setEditorKey] = useState(0);

  // Read the live draft on demand: title from the ref, body from Luthor's ref.
  const getDraft = useCallback((): Draft => ({
    title: titleRef.current,
    body: editorRef.current?.getMarkdown() ?? body,
  }), [body]);

  const { status, isDirty, bump, reset, savedRef } = useAutoSave(note, getDraft);

  // What the editor currently displays — the yardstick for detecting that the
  // server snapshot (refreshed by SignalR invalidation) carries a new revision.
  const shown = useRef({ id: note.id, title: note.title, body: note.body });
  // A remote revision held back because the local draft is dirty (caret guard).
  const [pending, setPending] = useState<{ title: string; body: string } | null>(null);

  // Force the editor to display a remote revision, re-baselining the save state
  // so the adopted content isn't immediately written back.
  const applyRemote = useCallback((next: { title: string; body: string }) => {
    titleRef.current = next.title;
    setTitle(next.title);
    setBody(next.body);
    setEditorKey((k) => k + 1);
    reset(next);
    shown.current = { id: note.id, ...next };
    setPending(null);
  }, [reset, note.id]);

  // React to a fresh server snapshot. SignalR's NoteUpdated invalidates the
  // notes query, so an external edit to the open note arrives here as a changed
  // `note` prop. Clean draft → apply instantly; dirty draft → hold + warn.
  useEffect(() => {
    const incoming = { title: note.title, body: note.body };
    if (note.id !== shown.current.id) { applyRemote(incoming); return; }
    if (incoming.title === shown.current.title && incoming.body === shown.current.body) return;
    // Our own save echoing back through the cache — adopt silently, no remount.
    if (incoming.title === savedRef.current.title && incoming.body === savedRef.current.body) {
      shown.current = { id: note.id, ...incoming };
      return;
    }
    if (!isDirty) { applyRemote(incoming); return; }
    // Dirty: protect the caret, surface the conflict for the user to resolve.
    shown.current = { id: note.id, ...incoming };
    setPending(incoming);
  }, [note, isDirty, applyRemote, savedRef]);

  // Keep my local edits and let the next save overwrite the remote revision.
  const keepLocal = useCallback(() => { setPending(null); bump(); }, [bump]);

  // YAML `color` tints the canvas; fonts come from the design tokens.
  const style = note.color ? { background: note.color } : undefined;

  return (
    <section className="note-editor" style={style}>
      <header className="note-editor__bar">
        <input
          className="note-editor__title"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          onChange={(e) => { titleRef.current = e.target.value; setTitle(e.target.value); bump(); }}
        />
        <span className="note-editor__status" role="status">
          {STATUS_LABEL[status]}
        </span>
      </header>

      {pending && (
        <div className="note-editor__conflict" role="alert">
          <span>This note was modified externally.</span>
          <div className="note-editor__conflict-actions">
            <button type="button" onClick={() => applyRemote(pending)}>Review</button>
            <button type="button" onClick={keepLocal}>Overwrite with Local</button>
          </div>
        </div>
      )}

      {/* contenteditable input events bubble here → mark the draft dirty. */}
      <div className="note-editor__canvas" onInput={bump}>
        <MarkDownEditor
          key={`${note.id}-${editorKey}`}
          initialTheme={theme}
          defaultContent={body}
          placeholder="Start writing…"
          onReady={(methods) => { editorRef.current = methods; }}
        />
      </div>
    </section>
  );
}
