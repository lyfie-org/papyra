import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkDownEditor } from '@lyfie/luthor';
import type { ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import { useNote, useCreateNote, useUpdateNote } from '../hooks/useNotes';
import type { CreateNoteRequest, UpdateNoteRequest } from '../types';
import './NoteEditorModal.css';

export interface NoteEditorModalProps {
  /** null = create new note, string = edit existing note by id */
  noteId: string | null;
  onClose: () => void;
}

const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export default function NoteEditorModal({ noteId, onClose }: NoteEditorModalProps) {
  const isEditing = noteId !== null;
  const { data: existingNote, isLoading } = useNote(noteId ?? '');

  const createNote = useCreateNote();
  const updateNote = useUpdateNote();

  const [title, setTitle] = useState('');
  const [color, setColor] = useState('#ffffff');
  const editorRef = useRef<ExtensiveEditorRef | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const externalContentRef = useRef<string | null>(null);

  const [editorKey, setEditorKey] = useState(() =>
    noteId !== null ? `${noteId}-initial` : 'new',
  );

  useEffect(() => {
    if (!existingNote) return;
    setTitle(existingNote.title);
    setColor(existingNote.color || '#ffffff');

    if (externalContentRef.current === null) {
      externalContentRef.current = existingNote.content;
    } else if (externalContentRef.current !== existingNote.content) {
      // Content changed externally (SignalR) — remount the editor with the new content
      externalContentRef.current = existingNote.content;
      setEditorKey(`${noteId ?? 'new'}-${Date.now()}`);
    }
  }, [existingNote, noteId]);

  // Focus trap: keeps Tab navigation inside the dialog and restores focus on close
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Re-query each time so elements mounted after open (e.g. the editor) are included
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };

    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      previouslyFocused?.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReady = useCallback((methods: ExtensiveEditorRef) => {
    editorRef.current = methods;
  }, []);

  const editorContent = isEditing ? (existingNote?.content ?? null) : '';
  const editorMountable = editorContent !== null;

  const handleSave = useCallback(async () => {
    const content = editorRef.current?.getMarkdown() ?? '';
    try {
      if (isEditing && noteId) {
        await updateNote.mutateAsync({ id: noteId, req: { title, content, color } });
      } else {
        // POST /notes doesn't accept content — create first, then patch
        const req: CreateNoteRequest = { title, color };
        const { id } = await createNote.mutateAsync(req);
        if (content.trim()) {
          await updateNote.mutateAsync({ id, req: { content } });
        }
      }
      onClose();
    } catch {
      // onError handles cache rollback
    }
  }, [isEditing, noteId, title, color, createNote, updateNote, onClose]);

  const isSaving = createNote.isPending || updateNote.isPending;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, handleSave]);

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-note-title"
        style={{ '--note-color': color } as React.CSSProperties}
      >
        <header className="modal-header">
          <input
            id="modal-note-title"
            className="modal-title-input"
            placeholder="Note title…"
            aria-label="Note title"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <div className="modal-header-actions">
            <label className="color-swatch">
              <span
                className="color-swatch__preview"
                style={{ background: color }}
                aria-hidden="true"
              />
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="color-swatch__input"
                aria-label="Note colour"
              />
            </label>
            <button className="btn btn--icon" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="modal-body">
          {isLoading && isEditing ? (
            <p className="modal-status">Loading…</p>
          ) : editorMountable ? (
            <MarkDownEditor
              key={editorKey}
              defaultContent={editorContent as string}
              onReady={handleReady}
              initialMode="visual"
              markdownSourceOfTruth={true}
              placeholder={{
                visual: 'Start writing… (type / for commands)',
                markdown: '# Start writing…',
              }}
              isEditorViewTabsVisible={true}
              className="luthor-editor"
            />
          ) : null}
        </div>

        <footer className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={isSaving || !title.trim()}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
