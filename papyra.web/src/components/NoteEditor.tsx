import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PapyraEditor, type PapyraEditorRef } from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import type { Note } from '../types/note';
import { useAutoSave, type Draft } from '../hooks/useAutoSave';
import { useTheme } from '../hooks/useTheme';
import { createPapyraEditorAdapter } from '../lib/papyraEditorAdapter';
import { putNote } from '../lib/notesApi';
import NoteToolbar from './NoteToolbar';
import SnapshotPanel from './SnapshotPanel';
import CategoryEditor from './CategoryEditor';
import GhostCards from './GhostCards';
import TimeMachineSlider from './TimeMachineSlider';
import NoteToc from './NoteToc';
import SecureNoteGate from './SecureNoteGate';
import { Minimize2, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useFocus } from '../hooks/useFocus';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useAmbient } from '../hooks/useAmbient';
import './NoteEditor.css';

// How long Lexical is given to finish reconciling (and re-normalising) the
// markdown it was mounted with before edit detection goes live.
const EDITOR_SETTLE_MS = 400;

const STATUS_LABEL = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved to local disk',
  queued: 'Saved on this device — will sync',
} as const;

// The editing canvas for a single note. Luthor's markdown preset owns the body
// (uncontrolled — content is read imperatively at save time); a Marcellus title
// input sits above it. Both feed the debounced auto-save.
export default function NoteEditor({ note }: { note: Note }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const editorRef = useRef<PapyraEditorRef | null>(null);
  // The wrapper around Luthor's contenteditable — edit detection is attached here.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // False until Lexical has finished mounting the note; see EDITOR_SETTLE_MS.
  const editorReady = useRef(false);
  // The scrolling editor panel — the ghost TOC measures heading offsets against it.
  const editorScrollRef = useRef<HTMLElement>(null);
  // Distraction-free focus mode (shared with the SignalR bridge, which buffers
  // updates while focused). Aliased to avoid clashing with the conflict-banner
  // `pending` state below.
  const { focus, pending: pendingUpdates, enter: enterFocus, exit: exitFocus, flush: flushUpdates } = useFocus();
  const ambient = useAmbient();

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
  // Latest markdown seen from the live editor, kept current on every input. Lets
  // a flush on close/unmount read the draft even after Luthor's ref tears down.
  const latestBody = useRef(note.body);

  // Read the live draft on demand: title from the ref, body from Luthor's ref
  // (falling back to the last value mirrored on input when the ref is gone).
  const getDraft = useCallback((): Draft => ({
    title: titleRef.current,
    body: editorRef.current?.getMarkdown() ?? latestBody.current,
  }), []);

  const { status, isDirty, bump, reset, flush, savedRef } = useAutoSave(note, getDraft);
  // Keyboard users land inside the editor instead of at the top of the page.
  useDialogFocus(editorScrollRef);

  // Time-machine scrub bar. While open, autosave is hard-disabled (suppressSave)
  // so previewing a historical revision never overwrites the live file — only an
  // explicit "Restore this version" writes to disk.
  const [timeMachine, setTimeMachine] = useState(false);
  const suppressSave = useRef(false);
  // A `secure: true` note arrives with an empty body — the API withholds it until a
  // biometric unlock. Until then the canvas is replaced by the gate, so the editor
  // can never autosave an empty body over the real (locked) content on disk.
  const [unlocked, setUnlocked] = useState(false);
  const isLocked = !!note.secure && !unlocked;

  // Close the editor modal: persist the draft first so closing never loses edits,
  // then return to the grid. Backdrop click and Escape both route here.
  const close = useCallback(async () => {
    // If the time machine is open, the editor is showing a historical preview —
    // restore the live draft before flushing so closing never writes an old
    // revision to disk.
    if (timeMachine) {
      editorRef.current?.setMarkdown(latestBody.current);
      suppressSave.current = false;
      setTimeMachine(false);
    }
    // A still-locked note holds an empty body (withheld server-side) — flushing
    // would write that emptiness over the real content on disk.
    if (!isLocked) await flush();
    navigate('/');
  }, [flush, navigate, timeMachine, isLocked]);

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
    latestBody.current = next.body;
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
    // Ask the editor itself whether it is holding unsaved text, rather than
    // trusting the isDirty flag alone. The flag is React state set from an
    // event handler, so a remote revision that lands in the same tick as the
    // keystroke can be processed while it still reads false — and adopting then
    // wipes the user's unsaved words with no warning. The draft comparison is a
    // ref read, always current.
    const draft = getDraft();
    const holdingUnsaved = isDirty
      || draft.title !== savedRef.current.title
      || draft.body !== savedRef.current.body;
    if (!holdingUnsaved) { applyRemote(incoming); return; }
    // Dirty: protect the caret, surface the conflict for the user to resolve.
    shown.current = { id: note.id, ...incoming };
    setPending(incoming);
  }, [note, isDirty, applyRemote, savedRef, getDraft]);

  // Keep my local edits and let the next save overwrite the remote revision.
  const keepLocal = useCallback(() => { setPending(null); bump(); }, [bump]);

  // Edit detection. Lexical calls stopPropagation on the contenteditable's `input`
  // event, so React's synthetic onInput (delegated at the root) never fired and
  // typing was silently never saved. Listen in the CAPTURE phase instead — that
  // runs before Lexical can stop it — and back it with a MutationObserver so
  // edits that don't emit an input event at all (toolbar formatting, slash
  // commands, undo, drag-drop) still mark the draft dirty. Both paths diff the
  // markdown against the last known text, so a re-render or a programmatic
  // setMarkdown can't masquerade as a user edit.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || isLocked) return;
    const onEdit = () => {
      // Suppressed while scrubbing history — a preview is not an edit, and must
      // never schedule a save of an old revision over the live file.
      if (suppressSave.current || !editorReady.current) return;
      const md = editorRef.current?.getMarkdown();
      if (md == null || md === latestBody.current) return;
      latestBody.current = md;
      bump();
    };
    el.addEventListener('input', onEdit, true);
    const observer = new MutationObserver(onEdit);
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      el.removeEventListener('input', onEdit, true);
      observer.disconnect();
    };
  }, [bump, isLocked, editorKey, note.id]);

  // Escape closes the modal — but let an open sub-panel (recovery) or the conflict
  // banner claim the key first so it doesn't yank the user out unexpectedly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape exits focus mode first (not the editor); otherwise let an open
      // sub-panel or the conflict banner claim it before closing the editor.
      if (focus) { exitFocus(); return; }
      if (!recoverOpen && !pending && !timeMachine) void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, recoverOpen, pending, timeMachine, focus, exitFocus]);

  // Toolbar frontmatter mutation: PUT the live draft plus the changed YAML field,
  // so a pin/color/archive flip never clobbers unsaved body/title. Re-baselines
  // the save state so the write doesn't immediately echo back as a dirty change.
  const saveFrontmatter = useCallback(async (patch: Partial<Pick<Note, 'color' | 'pinned' | 'archived' | 'tags' | 'kind'>>) => {
    // While locked the draft body is the withheld (empty) one — writing it would
    // destroy the note's real content, so frontmatter edits wait for the unlock.
    if (isLocked) return;
    const draft = getDraft();
    // Same offline-safe seam as the autosave path: parks in the outbox when the
    // API is unreachable instead of throwing away the toggle.
    await putNote(note.id, {
      title: draft.title,
      tags: patch.tags !== undefined ? patch.tags : note.tags,
      color: patch.color !== undefined ? patch.color : note.color,
      pinned: patch.pinned !== undefined ? patch.pinned : note.pinned,
      archived: patch.archived !== undefined ? patch.archived : note.archived,
      kind: patch.kind !== undefined ? patch.kind : note.kind,
      body: draft.body,
    }, note.updated);
    reset(draft);
    // A color flip remounts the editor (theme swap, see key/style below); seed the
    // fresh mount with the live text so unsaved edits survive the remount.
    latestBody.current = draft.body;
    setBody(draft.body);
    shown.current = { id: note.id, title: draft.title, body: draft.body };
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [getDraft, note, reset, queryClient, isLocked]);

  // Enter the time machine. Flush any unsaved edits FIRST (so the live draft is on
  // disk and the slider's "Now" matches it), then hard-disable autosave for the
  // duration. Without the upfront flush a pending debounce could fire mid-scrub and
  // write a historical revision over the live file.
  const openTimeMachine = useCallback(async () => {
    await flush();
    // Cancel any still-pending debounce from edits made just before opening —
    // otherwise it could fire mid-scrub and flush the previewed (old) body. reset
    // clears the timer and re-baselines to the now-saved live draft.
    reset(getDraft());
    suppressSave.current = true;
    setTimeMachine(true);
  }, [flush, reset, getDraft]);

  // Exit without restoring: put the live draft back on screen and re-enable saving.
  const closeTimeMachine = useCallback(() => {
    editorRef.current?.setMarkdown(latestBody.current);
    suppressSave.current = false;
    setTimeMachine(false);
  }, []);

  // Restore a scrubbed revision: the API archives the current version first (so the
  // restore is itself reversible), then the refetched note adopts via forceAdopt.
  const restoreVersion = useCallback(async (snapshotId: string) => {
    const res = await fetch(
      `/api/notes/${encodeURIComponent(note.id)}/restore/${encodeURIComponent(snapshotId)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(`POST restore failed: ${res.status}`);
    forceAdopt.current = true; // adopt the restored body even over the scrubbed view
    suppressSave.current = false;
    setTimeMachine(false);
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [note.id, queryClient]);

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
    <div
      className={`note-modal${focus ? ' note-modal--focus' : ''}`}
      onMouseDown={(e) => { if (!focus && e.target === e.currentTarget) void close(); }}
    >
    <section
      ref={editorScrollRef}
      className={`note-editor${colored ? ' note-editor--colored' : ''}${focus ? ' note-editor--focus' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={`Note editor: ${title.trim() || 'Untitled'}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {focus && (
        <div className="note-editor__focusbar">
          {pendingUpdates > 0 && (
            <button type="button" className="note-editor__pending" onClick={() => flushUpdates()}>
              <RefreshCw size={14} /> {pendingUpdates} new update{pendingUpdates > 1 ? 's' : ''} pending
            </button>
          )}
          <button
            type="button"
            className="note-editor__focusbtn"
            aria-pressed={ambient.playing}
            aria-label={ambient.playing ? 'Mute ambient audio' : 'Play ambient audio'}
            onClick={ambient.toggle}
          >
            {ambient.playing ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <button type="button" className="note-editor__focusbtn" aria-label="Exit focus mode" onClick={exitFocus}>
            <Minimize2 size={16} />
          </button>
        </div>
      )}

      {!focus && <NoteToc scrollRef={editorScrollRef} />}

      <header className="note-editor__bar">
        <input
          className="note-editor__title"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          // Locked notes are read-only until unlocked: a title edit would schedule a
          // save whose (withheld) body is empty.
          readOnly={isLocked}
          onChange={(e) => { titleRef.current = e.target.value; setTitle(e.target.value); bump(); }}
        />
        {!focus && (
          <>
            <span className="note-editor__status" role="status">
              {STATUS_LABEL[status]}
            </span>
            <NoteToolbar
              pinned={note.pinned}
              color={note.color}
              isTodo={note.kind === 'todo'}
              onTogglePin={() => void saveFrontmatter({ pinned: !note.pinned })}
              onToggleTodo={() => void saveFrontmatter({ kind: note.kind === 'todo' ? 'note' : 'todo' })}
              onPickColor={(c) => void saveFrontmatter({ color: c })}
              onRecover={() => setRecoverOpen(true)}
              onTimeMachine={() => void openTimeMachine()}
              onFocus={enterFocus}
              onArchive={() => { void saveFrontmatter({ archived: true }); navigate('/'); }}
              onTrash={() => {
                if (confirm('Delete this note? This permanently removes the .md file.')) void trash();
              }}
            />
          </>
        )}
      </header>

      {!focus && <CategoryEditor tags={note.tags} onChange={(tags) => void saveFrontmatter({ tags })} />}

      {pending && (
        <div className="note-editor__conflict" role="alert">
          <span>This note was modified externally.</span>
          <div className="note-editor__conflict-actions">
            <button type="button" onClick={() => applyRemote(pending)}>Review</button>
            <button type="button" onClick={keepLocal}>Overwrite with Local</button>
          </div>
        </div>
      )}

      {timeMachine && (
        <TimeMachineSlider
          noteId={note.id}
          liveBody={latestBody.current}
          onPreview={(b) => editorRef.current?.setMarkdown(b)}
          onRestore={restoreVersion}
          onClose={closeTimeMachine}
        />
      )}

      {isLocked && (
        <SecureNoteGate
          noteId={note.id}
          onUnlocked={(revealed) => {
            // Adopt the revealed body and re-baseline, so the unlock itself is never
            // mistaken for an edit.
            applyRemote({ title: note.title, body: revealed });
            setUnlocked(true);
          }}
        />
      )}

      {/* Edits are detected natively (see the observer effect) — Lexical swallows
          the bubbling `input` event, so a React onInput here would never fire. */}
      {!isLocked && (
      <div className="note-editor__canvas" ref={canvasRef}>
        <PapyraEditor
          key={`${note.id}-${editorKey}-${editorTheme}-${note.color ?? 'none'}`}
          initialTheme={theme}
          colored={colored}
          defaultEditorView="visual"
          defaultContent={body}
          placeholder="Start writing…"
          adapter={adapter}
          onReady={(methods) => {
            editorRef.current = methods;
            // defaultContent loads as plain text, so parse the markdown into the
            // visual surface explicitly — otherwise the body renders as raw source.
            editorReady.current = false;
            methods.setMarkdown(body);
            // Lexical keeps reconciling for a few frames after setMarkdown, and it
            // re-normalises the markdown it round-trips. Adopt that normalised text
            // as the baseline once it settles, so mounting a note is never mistaken
            // for an edit (which would autosave every note the moment it opened).
            window.setTimeout(() => {
              latestBody.current = methods.getMarkdown();
              editorReady.current = true;
            }, EDITOR_SETTLE_MS);
          }}
        />
      </div>
      )}

      {!focus && !isLocked && <GhostCards noteId={note.id} />}

      {recoverOpen && (
        <SnapshotPanel
          noteId={note.id}
          currentBody={getDraft().body}
          onClose={() => setRecoverOpen(false)}
          onRestored={() => { forceAdopt.current = true; }}
        />
      )}
    </section>
    </div>
  );
}
