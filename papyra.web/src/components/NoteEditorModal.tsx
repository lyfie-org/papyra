import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkDownEditor } from '@lyfie/luthor';
import type { ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import { Check, X, FloppyDisk, WarningCircle, ShareNetwork } from '@phosphor-icons/react';
import { useNote, useCreateNote, useUpdateNote } from '../hooks/useNotes';
import { useNoteGroup } from '../hooks/useNoteGroup';
import { useAuth } from '../hooks/useAuth';
import { resolveTheme } from '../lib/noteThemes';
import { useTheme } from '../hooks/useTheme';
import type { CreateNoteRequest } from '../types';
import ThemeChooser from './ThemeChooser';
import SharePanel from './SharePanel';
import './NoteEditorModal.css';

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export interface NoteEditorModalProps {
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

const DEBOUNCE_MS    = 1000;
const SAVED_LINGER_MS = 2000;

export default function NoteEditorModal({ noteId, onClose }: NoteEditorModalProps) {
  const isEditing = noteId !== null;
  const { data: existingNote, isLoading } = useNote(noteId ?? '');
  const { data: auth }  = useAuth();
  const { theme: appTheme } = useTheme();
  const [shareOpen, setShareOpen] = useState(false);

  const createNote = useCreateNote();
  const updateNote = useUpdateNote();

  const [title, setTitle]        = useState('');
  const [theme, setTheme]        = useState<string>('default');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [editorKey, setEditorKey] = useState(() =>
    noteId !== null ? `${noteId}-initial` : 'new',
  );

  const editorRef   = useRef<ExtensiveEditorRef | null>(null);
  const dialogRef   = useRef<HTMLDivElement>(null);

  const localNoteIdRef              = useRef<string | null>(noteId);
  const lastAutoSavedContentRef     = useRef<string>('');
  const externalContentRef          = useRef<string | null>(null);
  const titleRef                    = useRef(title);
  const themeRef                    = useRef(theme);
  const debounceTimerRef            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef              = useRef(!isEditing);
  // Track the last delta we sent so we don't echo our own broadcasts back.
  const lastSentDeltaRef            = useRef<string>('');

  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  // ── Collaborative: receive content delta from another editor ────────────────
  const handleRemoteDelta = useCallback((delta: string) => {
    // Ignore if this is our own echo (shouldn't happen — hub sends to OthersInGroup)
    if (delta === lastSentDeltaRef.current) return;
    // Only update if the content actually differs from what we have
    const currentContent = editorRef.current?.getMarkdown() ?? '';
    if (delta === currentContent) return;
    // Trigger remount with the received content (preserves the existing remount logic)
    externalContentRef.current = delta;
    lastAutoSavedContentRef.current = delta;
    setEditorKey(`${localNoteIdRef.current}-collab-${Date.now()}`);
  }, []);

  const { sendDelta } = useNoteGroup(
    isEditing ? noteId : null,
    handleRemoteDelta,
  );

  // ── Load existing note ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!existingNote) return;

    if (!initializedRef.current) {
      initializedRef.current = true;
      setTitle(existingNote.title);
      setTheme(existingNote.color || 'default');
      externalContentRef.current = existingNote.content;
      lastAutoSavedContentRef.current = existingNote.content;
      return;
    }

    if (existingNote.content === externalContentRef.current) return;

    if (existingNote.content === lastAutoSavedContentRef.current) {
      externalContentRef.current = existingNote.content;
    } else {
      externalContentRef.current = existingNote.content;
      setEditorKey(`${noteId}-${Date.now()}`);
    }
  }, [existingNote, noteId]);

  // ── Focus trap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
      }
    };

    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      previouslyFocused?.focus();
    };
  }, []);

  const handleReady = useCallback((methods: ExtensiveEditorRef) => {
    editorRef.current = methods;
  }, []);

  const markSaved = useCallback(() => {
    setSaveStatus('saved');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), SAVED_LINGER_MS);
  }, []);

  const autoSave = useCallback(() => {
    const content  = editorRef.current?.getMarkdown() ?? '';
    const id       = localNoteIdRef.current;
    const curTitle = titleRef.current;
    const curTheme = themeRef.current;

    setSaveStatus('saving');

    if (id) {
      lastAutoSavedContentRef.current = content;
      lastSentDeltaRef.current = content;
      // Broadcast delta to collaborators in the same note group.
      sendDelta(content);
      updateNote.mutate(
        { id, req: { title: curTitle, content, color: curTheme } },
        { onSuccess: markSaved, onError: () => setSaveStatus('error') },
      );
    } else if (curTitle.trim()) {
      const req: CreateNoteRequest = { title: curTitle, color: curTheme };
      createNote.mutate(req, {
        onSuccess: ({ id: newId }) => {
          localNoteIdRef.current = newId;
          lastAutoSavedContentRef.current = content;
          if (content.trim()) {
            updateNote.mutate(
              { id: newId, req: { content } },
              { onSuccess: markSaved, onError: () => setSaveStatus('error') },
            );
          } else {
            markSaved();
          }
        },
        onError: () => setSaveStatus('error'),
      });
    } else {
      setSaveStatus('idle');
    }
  }, [createNote, updateNote, markSaved, sendDelta]);

  const scheduleAutoSave = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(autoSave, DEBOUNCE_MS);
  }, [autoSave]);

  const flushAndClose = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    // Always flush content to the server on close — the debounce may not have
    // fired yet (e.g. editor events don't always bubble as native input events).
    if (localNoteIdRef.current || titleRef.current.trim()) autoSave();
    onClose();
  }, [autoSave, onClose]);

  const handleThemeSelect = useCallback((newTheme: string) => {
    setTheme(newTheme);
    themeRef.current = newTheme;
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.addEventListener('input', scheduleAutoSave);
    return () => {
      dialog.removeEventListener('input', scheduleAutoSave);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (savedTimerRef.current)    clearTimeout(savedTimerRef.current);
    };
  }, [scheduleAutoSave]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { flushAndClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        autoSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [flushAndClose, autoSave]);

  const editorContent   = isEditing ? (existingNote?.content ?? null) : '';
  const editorMountable = editorContent !== null;
  const { colorTheme, artTheme } = resolveTheme(theme);

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) flushAndClose(); }}
    >
      <div
        ref={dialogRef}
        className="modal-dialog"
        data-note-theme={colorTheme}
        data-note-art={artTheme}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-note-title"
      >
        <header className="modal-header">
          <div className="modal-header-title-area">
            <input
              id="modal-note-title"
              className="modal-title-input"
              placeholder="Note title"
              aria-label="Note title"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
            <div
              className={['modal-persistent-status', `modal-persistent-status--${saveStatus}`].join(' ')}
              aria-live="polite"
              aria-atomic="true"
            >
              {saveStatus === 'error'
                ? <><WarningCircle size={12} aria-hidden="true" /> Failed to save</>
                : saveStatus === 'saving'
                  ? 'Saving…'
                  : <><Check size={11} aria-hidden="true" /> All changes saved</>}
              {saveStatus === 'error' && (
                <button
                  className="btn btn--save-now"
                  onClick={e => { e.stopPropagation(); autoSave(); }}
                  aria-label="Save now"
                >
                  <FloppyDisk size={13} aria-hidden="true" />
                  Save
                </button>
              )}
            </div>
          </div>
          <div className="modal-header-actions">
            <ThemeChooser currentTheme={theme} onSelect={handleThemeSelect} />
            {isEditing && existingNote?.owner === auth?.username && (
              <button
                className={`btn btn--icon${shareOpen ? ' btn--icon-active' : ''}`}
                aria-label="Share note"
                aria-pressed={shareOpen}
                onClick={() => setShareOpen(v => !v)}
              >
                <ShareNetwork size={16} aria-hidden="true" />
              </button>
            )}
            <button
              className="btn btn--icon"
              aria-label="Close note editor"
              onClick={flushAndClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {shareOpen && noteId && (
          <SharePanel noteId={noteId} onClose={() => setShareOpen(false)} />
        )}

        <div className="modal-body">
          {isLoading && isEditing ? (
            <p className="modal-status">Loading…</p>
          ) : editorMountable ? (
            <MarkDownEditor
              key={editorKey}
              defaultContent={editorContent as string}
              onReady={handleReady}
              initialMode="visual"
              initialTheme={appTheme}
              markdownSourceOfTruth={true}
              placeholder={{
                visual: 'Start writing… (type / for commands)',
                markdown: '# Start writing',
              }}
              isEditorViewTabsVisible={true}
              className="luthor-editor"
            />
          ) : null}
        </div>

        <footer className="modal-footer">
          <button className="btn btn--ghost" onClick={flushAndClose}>
            Close
          </button>
          <div className="modal-footer-dates">
            {existingNote?.createdAt && (
              <span className="modal-footer-date-item">
                <span className="modal-footer-date-label">Created</span>
                {formatDateTime(existingNote.createdAt)}
              </span>
            )}
            {existingNote?.updatedAt && (
              <span className="modal-footer-date-item">
                <span className="modal-footer-date-label">Modified</span>
                {formatDateTime(existingNote.updatedAt)}
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
