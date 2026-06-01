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

export default function NoteEditorModal({ noteId, onClose }: NoteEditorModalProps) {
  const isEditing = noteId !== null;
  const { data: existingNote, isLoading } = useNote(noteId ?? '');

  const createNote = useCreateNote();
  const updateNote = useUpdateNote();

  const [title, setTitle] = useState('');
  const [color, setColor] = useState('#ffffff');
  const editorRef = useRef<ExtensiveEditorRef | null>(null);

  // Populate header fields once the note data arrives
  useEffect(() => {
    if (existingNote) {
      setTitle(existingNote.title);
      setColor(existingNote.color || '#ffffff');
    }
  }, [existingNote]);

  const handleReady = useCallback((methods: ExtensiveEditorRef) => {
    editorRef.current = methods;
  }, []);

  // Don't mount the editor until we have the content for edits.
  // For new notes content is '' so it's immediately ready.
  const editorContent = isEditing ? (existingNote?.content ?? null) : '';
  const editorMountable = editorContent !== null;

  const handleSave = useCallback(async () => {
    const content = editorRef.current?.getMarkdown() ?? '';
    try {
      if (isEditing && noteId) {
        const req: UpdateNoteRequest = { title, content, color };
        await updateNote.mutateAsync({ id: noteId, req });
      } else {
        // Create the note, then patch content in a second request
        // (POST /notes doesn't accept content in the current API)
        const req: CreateNoteRequest = { title, color };
        const { id } = await createNote.mutateAsync(req);
        if (content.trim()) {
          await updateNote.mutateAsync({ id, req: { content } });
        }
      }
      onClose();
    } catch {
      // Mutation onError handles cache rollback; nothing extra needed here
    }
  }, [isEditing, noteId, title, color, createNote, updateNote, onClose]);

  const isSaving = createNote.isPending || updateNote.isPending;

  // Keyboard shortcuts: Escape → close, Ctrl/Cmd+S → save
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
      role="dialog"
      aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="modal-dialog"
        style={{ '--note-color': color } as React.CSSProperties}
      >
        {/* ── Header ── */}
        <header className="modal-header">
          <input
            className="modal-title-input"
            placeholder="Note title…"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus={!isEditing}
          />
          <div className="modal-header-actions">
            <label className="color-swatch" title="Note colour">
              <span
                className="color-swatch__preview"
                style={{ background: color }}
              />
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="color-swatch__input"
              />
            </label>
            <button className="btn btn--icon" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        {/* ── Body / Luthor MarkDownEditor ── */}
        <div className="modal-body">
          {isLoading && isEditing ? (
            <p className="modal-status">Loading…</p>
          ) : editorMountable ? (
            /*
             * key forces a full remount when switching between notes so
             * defaultContent is re-applied from scratch each time.
             */
            <MarkDownEditor
              key={isEditing ? noteId : 'new'}
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

        {/* ── Footer ── */}
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
