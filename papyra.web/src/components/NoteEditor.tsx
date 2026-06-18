import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PapyraEditor, type PapyraEditorRef } from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import type { Note } from '../types/note';
import { useAutoSave, type Draft } from '../hooks/useAutoSave';
import { useTheme } from '../hooks/useTheme';
import { createPapyraEditorAdapter } from '../lib/papyraEditorAdapter';
import NoteToolbar from './NoteToolbar';
import SnapshotPanel from './SnapshotPanel';
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const editorRef = useRef<PapyraEditorRef | null>(null);

  // The host seam: media GET/upload → /api/media, [[ search → notes cache,
  // wikilink activation → router push. Rebuilt only when the open note or the
  // injected services change. The editor owns the drop/paste upload pipeline
  // through adapter.uploadMedia, so Papyra no longer hand-splices ![[…]].
  const adapter = useMemo(
    () => createPapyraEditorAdapter({ noteId: note.id, navigate, queryClient }),
    [note.id, navigate, queryClient],
  );
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
  // File-recovery overlay; while open the live draft body feeds the diff.
  const [recoverOpen, setRecoverOpen] = useState(false);
  // A restore is a deliberate adopt — override the dirty caret-guard for the
  // refetched (restored) revision so it lands even over unsaved edits.
  const forceAdopt = useRef(false);

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
    // A just-restored revision: adopt it even if the draft was dirty.
    if (forceAdopt.current) { forceAdopt.current = false; applyRemote(incoming); return; }
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

  // Toolbar frontmatter mutation: PUT the live draft plus the changed YAML field,
  // so a pin/color/archive flip never clobbers unsaved body/title. Re-baselines
  // the save state so the write doesn't immediately echo back as a dirty change.
  const saveFrontmatter = useCallback(async (patch: Partial<Pick<Note, 'color' | 'pinned' | 'archived'>>) => {
    const draft = getDraft();
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        tags: note.tags,
        color: patch.color !== undefined ? patch.color : note.color,
        pinned: patch.pinned !== undefined ? patch.pinned : note.pinned,
        archived: patch.archived !== undefined ? patch.archived : note.archived,
        body: draft.body,
      }),
    });
    if (!res.ok) throw new Error(`PUT /api/notes/${note.id} failed: ${res.status}`);
    reset(draft);
    // A color flip remounts the editor (theme swap, see key/style below); seed the
    // fresh mount with the live text so unsaved edits survive the remount.
    setBody(draft.body);
    shown.current = { id: note.id, title: draft.title, body: draft.body };
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [getDraft, note, reset, queryClient]);

  // Trash: hard-delete the .md (irreversible) then leave the editor.
  const trash = useCallback(async () => {
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`DELETE /api/notes/${note.id} failed: ${res.status}`);
    queryClient.invalidateQueries({ queryKey: ['notes'] });
    navigate('/');
  }, [note.id, queryClient, navigate]);

  // YAML `color` tints the canvas; fonts come from the design tokens. The palette
  // tints are always light, so a coloured note forces a light editor (dark ink)
  // in both app themes — matching the card convention. Uncoloured notes follow
  // the live app theme. The luthor theme only applies on mount, so both the tint
  // and the resolved theme are folded into the editor key to re-theme on change.
  const colored = !!note.color;
  const editorTheme = colored ? 'light' : theme;
  const style = note.color ? { background: note.color } : undefined;

  return (
    <section className={`note-editor${colored ? ' note-editor--colored' : ''}`} style={style}>
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
        <NoteToolbar
          pinned={note.pinned}
          color={note.color}
          onTogglePin={() => void saveFrontmatter({ pinned: !note.pinned })}
          onPickColor={(c) => void saveFrontmatter({ color: c })}
          onRecover={() => setRecoverOpen(true)}
          onArchive={() => { void saveFrontmatter({ archived: true }); navigate('/'); }}
          onTrash={() => {
            if (confirm('Delete this note? This permanently removes the .md file.')) void trash();
          }}
        />
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
        <PapyraEditor
          key={`${note.id}-${editorKey}-${editorTheme}-${note.color ?? 'none'}`}
          initialTheme={theme}
          colored={colored}
          defaultContent={body}
          placeholder="Start writing…"
          adapter={adapter}
          onReady={(methods) => { editorRef.current = methods; }}
        />
      </div>

      {recoverOpen && (
        <SnapshotPanel
          noteId={note.id}
          currentBody={getDraft().body}
          onClose={() => setRecoverOpen(false)}
          onRestored={() => { forceAdopt.current = true; }}
        />
      )}
    </section>
  );
}
