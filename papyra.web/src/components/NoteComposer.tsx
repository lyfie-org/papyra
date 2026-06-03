import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkDownEditor } from '@lyfie/luthor';
import type { ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import { CheckSquare, Check } from '@phosphor-icons/react';
import { useCreateNote, useUpdateNote } from '../hooks/useNotes';
import { useRelativeTime } from '../hooks/useRelativeTime';
import { useTheme } from '../hooks/useTheme';
import type { CreateNoteRequest } from '../types';
import './NoteComposer.css';

const DEBOUNCE_MS  = 1000;
const SAVED_LINGER = 1500;

export default function NoteComposer() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [title, setTitle]           = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [composerKey, setComposerKey] = useState(0);
  const [lastSavedIso, setLastSavedIso] = useState<string | undefined>(undefined);

  const composerRef    = useRef<HTMLDivElement>(null);
  const titleInputRef  = useRef<HTMLInputElement>(null);
  const editorRef      = useRef<ExtensiveEditorRef | null>(null);
  const localNoteIdRef = useRef<string | null>(null);
  const titleRef       = useRef(title);
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContentRef = useRef('');

  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const { theme: appTheme } = useTheme();

  const lastSavedLabel = useRelativeTime(lastSavedIso);

  // ── Sync title into ref so autoSave captures the latest value ────────────

  useEffect(() => { titleRef.current = title; }, [title]);

  // ── Focus title input when expanding ─────────────────────────────────────

  useEffect(() => {
    if (isExpanded) {
      const id = setTimeout(() => titleInputRef.current?.focus(), 40);
      return () => clearTimeout(id);
    }
  }, [isExpanded]);

  // ── Auto-save ─────────────────────────────────────────────────────────────

  const markSaved = useCallback(() => {
    setSaveStatus('saved');
    setLastSavedIso(new Date().toISOString());
    if (savedRef.current) clearTimeout(savedRef.current);
    savedRef.current = setTimeout(() => setSaveStatus('idle'), SAVED_LINGER);
  }, []);

  const autoSave = useCallback(() => {
    const content  = editorRef.current?.getMarkdown() ?? '';
    const id       = localNoteIdRef.current;
    const curTitle = titleRef.current;

    setSaveStatus('saving');

    if (id) {
      lastSavedContentRef.current = content;
      updateNote.mutate(
        { id, req: { title: curTitle, content } },
        { onSuccess: markSaved, onError: () => setSaveStatus('idle') },
      );
    } else if (curTitle.trim()) {
      const req: CreateNoteRequest = { title: curTitle };
      createNote.mutate(req, {
        onSuccess: ({ id: newId }) => {
          localNoteIdRef.current = newId;
          lastSavedContentRef.current = content;
          if (content.trim()) {
            updateNote.mutate(
              { id: newId, req: { content } },
              { onSuccess: markSaved, onError: () => setSaveStatus('idle') },
            );
          } else {
            markSaved();
          }
        },
        onError: () => setSaveStatus('idle'),
      });
    } else {
      setSaveStatus('idle');
    }
  }, [createNote, updateNote, markSaved]);

  const scheduleAutoSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(autoSave, DEBOUNCE_MS);
  }, [autoSave]);

  const resetComposer = useCallback(() => {
    setTitle('');
    setSaveStatus('idle');
    setLastSavedIso(undefined);
    setComposerKey(k => k + 1);
    localNoteIdRef.current = null;
    lastSavedContentRef.current = '';
    setIsExpanded(false);
  }, []);

  const flushAndClose = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (localNoteIdRef.current || titleRef.current.trim()) autoSave();
    resetComposer();
  }, [autoSave, resetComposer]);

  // ── Click-outside ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: MouseEvent) => {
      if (!composerRef.current?.contains(e.target as Node)) flushAndClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isExpanded, flushAndClose]);

  // ── Escape key ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') flushAndClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isExpanded, flushAndClose]);

  // ── Input listener (bubbles from Luthor contenteditable + title input) ────

  useEffect(() => {
    const el = composerRef.current;
    if (!el || !isExpanded) return;
    el.addEventListener('input', scheduleAutoSave);
    return () => {
      el.removeEventListener('input', scheduleAutoSave);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedRef.current)    clearTimeout(savedRef.current);
    };
  }, [scheduleAutoSave, isExpanded]);

  const handleEditorReady = useCallback((methods: ExtensiveEditorRef) => {
    editorRef.current = methods;
  }, []);

  const expand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div ref={composerRef} className="note-composer">
      {/* ── Closed trigger ─────────────────────────────────────────────── */}
      {!isExpanded && (
        <div
          className="note-composer__trigger"
          onClick={expand}
          role="button"
          aria-label="Create a new note"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && setIsExpanded(true)}
        >
          <span className="note-composer__placeholder">Take a note...</span>
          <div className="note-composer__quick-actions" onClick={e => e.stopPropagation()}>
            <button
              className="note-composer__quick-btn"
              title="New checklist"
              aria-label="New checklist note"
              onClick={expand}
            >
              <CheckSquare size={19} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* ── Expanded canvas ─────────────────────────────────────────────── */}
      {isExpanded && (
        <div className="note-composer__canvas">
          <input
            ref={titleInputRef}
            className="note-composer__title"
            placeholder="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            aria-label="Note title"
          />

          <MarkDownEditor
            key={`composer-${composerKey}`}
            defaultContent=""
            onReady={handleEditorReady}
            initialMode="visual"
            initialTheme={appTheme}
            markdownSourceOfTruth={true}
            placeholder={{ visual: 'Take a note…', markdown: '' }}
            isEditorViewTabsVisible={false}
            className="note-composer__editor"
          />

          <div className="note-composer__footer">
            <button className="note-composer__close-btn" onClick={flushAndClose}>
              Close
            </button>

            <div className="note-composer__meta">
              <span
                className={[
                  'note-composer__saved-badge',
                  saveStatus === 'saved' ? 'note-composer__saved-badge--visible' : '',
                ].filter(Boolean).join(' ')}
                aria-live="polite"
                aria-atomic="true"
              >
                <Check size={11} aria-hidden="true" />
                Saved
              </span>
              {lastSavedLabel && (
                <span className="note-composer__date">
                  Edited {lastSavedLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
