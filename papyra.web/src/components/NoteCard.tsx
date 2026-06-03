import { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Palette, PushPin, Bell, UserPlus, Image as ImageIcon, Archive, DotsThreeVertical, CheckCircle, Circle, Trash, Copy, Tag, CheckSquare } from '@phosphor-icons/react';
import type { NoteSummary } from '../types';
import { useUpdateNote, useDeleteNote, useArchiveNote, useTrashNote } from '../hooks/useNotes';
import { resolveTheme } from '../lib/noteThemes';
import { useRelativeTime } from '../hooks/useRelativeTime';
import { useSelection } from '../context/SelectionContext';
import ThemeChooser from './ThemeChooser';
import './NoteCard.css';

type PopoverPos = { bottom: number; left?: number; right?: number };

interface NoteCardProps {
  note: NoteSummary;
  onClick: () => void;
}

const MAX_CONTENT_CHARS = 180;

export default function NoteCard({ note, onClick }: NoteCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [palettePos, setPalettePos] = useState<PopoverPos | null>(null);
  const [morePos, setMorePos] = useState<PopoverPos | null>(null);

  const updateNote  = useUpdateNote();
  const deleteNote  = useDeleteNote();
  const archiveNote = useArchiveNote();
  const trashNote   = useTrashNote();
  const paletteRef  = useRef<HTMLButtonElement>(null);
  const moreRef     = useRef<HTMLButtonElement>(null);
  const palettePopRef = useRef<HTMLDivElement>(null);
  const moreMenuRef   = useRef<HTMLDivElement>(null);
  const { isSelected, toggleSelect, hasSelection } = useSelection();

  const selected = isSelected(note.id);
  const { colorTheme, artTheme } = resolveTheme(note.color);
  const editedLabel = useRelativeTime(note.updatedAt ?? note.createdAt);

  const snippet = 'content' in note && typeof (note as { content?: string }).content === 'string'
    ? ((note as { content?: string }).content!.length > MAX_CONTENT_CHARS
        ? (note as { content?: string }).content!.slice(0, MAX_CONTENT_CHARS).trimEnd() + '…'
        : (note as { content?: string }).content!)
    : null;

  const getPopoverPos = useCallback((
    ref: React.RefObject<HTMLButtonElement | null>,
    anchor: 'left' | 'right',
  ): PopoverPos | null => {
    if (!ref.current) return null;
    const rect = ref.current.getBoundingClientRect();
    return anchor === 'left'
      ? { bottom: window.innerHeight - rect.top + 6, left: rect.left }
      : { bottom: window.innerHeight - rect.top + 6, right: window.innerWidth - rect.right };
  }, []);

  // Close popups on outside click
  useEffect(() => {
    if (!pickerOpen && !moreOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pickerOpen &&
          !paletteRef.current?.contains(t) &&
          !palettePopRef.current?.contains(t)) {
        setPickerOpen(false);
        setPalettePos(null);
      }
      if (moreOpen &&
          !moreRef.current?.contains(t) &&
          !moreMenuRef.current?.contains(t)) {
        setMoreOpen(false);
        setMorePos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen, moreOpen]);

  const handleCardClick = () => {
    if (pickerOpen) { setPickerOpen(false); setPalettePos(null); return; }
    if (moreOpen)   { setMoreOpen(false);   setMorePos(null);    return; }
    onClick();
  };

  const handlePaletteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    setMorePos(null);
    if (!pickerOpen) {
      setPalettePos(getPopoverPos(paletteRef, 'left'));
      setPickerOpen(true);
    } else {
      setPickerOpen(false);
      setPalettePos(null);
    }
  };

  const handleThemeSelect = (newTheme: string) => {
    updateNote.mutate({ id: note.id, req: { color: newTheme } });
    setPickerOpen(false);
    setPalettePos(null);
  };

  const togglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateNote.mutate({ id: note.id, req: { pinned: !note.pinned } });
  };

  const handleSelect = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleSelect(note.id);
  };

  const handleMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPickerOpen(false);
    setPalettePos(null);
    if (!moreOpen) {
      setMorePos(getPopoverPos(moreRef, 'right'));
      setMoreOpen(true);
    } else {
      setMoreOpen(false);
      setMorePos(null);
    }
  };

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    archiveNote.mutate(note.id);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    setMorePos(null);
    trashNote.mutate(note.id);
  };

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    setMorePos(null);
    updateNote.mutate({ id: note.id, req: {} });
  };

  return (
    <article
      className={['note-card', selected ? 'note-card--selected' : ''].filter(Boolean).join(' ')}
      data-note-theme={colorTheme}
      data-note-art={artTheme}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && handleCardClick()}
      aria-label={`Open note: ${note.title}`}
    >
      {/* Top-left checkbox */}
      <button
        className={['note-card__select-btn', selected || hasSelection ? 'note-card__select-btn--visible' : ''].filter(Boolean).join(' ')}
        onClick={handleSelect}
        aria-label={selected ? "Deselect note" : "Select note"}
      >
        {selected
          ? <CheckCircle size={20} className="note-card__select-icon--checked" />
          : <Circle size={20} className="note-card__select-icon" />}
      </button>

      {/* Top-right pin */}
      <button
        className={['note-card__pin-btn', note.pinned ? 'note-card__pin-btn--visible' : ''].filter(Boolean).join(' ')}
        onClick={togglePin}
        aria-label={note.pinned ? "Unpin note" : "Pin note"}
      >
        <PushPin size={20} className={note.pinned ? 'note-card__pin-icon--pinned' : 'note-card__pin-icon'} aria-hidden="true" />
      </button>

      {/* Scrollable content body — never overlapped by toolbar */}
      <div className="note-card__body">
        <header className="note-card__header">
          <h2 className="note-card__title">{note.title}</h2>
        </header>

        {snippet && <p className="note-card__content">{snippet}</p>}

        {note.tags.length > 0 && (
          <ul className="note-card__tags" aria-label="Tags">
            {note.tags.map(tag => (
              <li key={tag} className="note-card__tag">{tag}</li>
            ))}
          </ul>
        )}

        {editedLabel && (
          <p className="note-card__meta">Edited {editedLabel}</p>
        )}
      </div>

      {/* Structural actions bar — occupies real space, never floats over content */}
      <div className="note-card__actions">
        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Reminders">
          <Bell size={14} aria-hidden="true" />
        </button>
        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Collaborators">
          <UserPlus size={14} aria-hidden="true" />
        </button>

        <button
          ref={paletteRef}
          className={['note-card__toolbar-btn', pickerOpen ? 'note-card__toolbar-btn--active' : ''].filter(Boolean).join(' ')}
          onClick={handlePaletteClick}
          aria-label="Change note colour"
          aria-expanded={pickerOpen}
          aria-haspopup="listbox"
        >
          <Palette size={14} aria-hidden="true" />
        </button>

        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Add image">
          <ImageIcon size={14} aria-hidden="true" />
        </button>
        <button className="note-card__toolbar-btn" onClick={handleArchive} aria-label="Archive note">
          <Archive size={14} aria-hidden="true" />
        </button>

        <button
          ref={moreRef}
          className={['note-card__toolbar-btn', moreOpen ? 'note-card__toolbar-btn--active' : ''].filter(Boolean).join(' ')}
          onClick={handleMoreClick}
          aria-label="More options"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
        >
          <DotsThreeVertical size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Theme picker portal — escapes card overflow */}
      {pickerOpen && palettePos && createPortal(
        <div
          ref={palettePopRef}
          className="note-card__theme-popover note-card__theme-popover--portal"
          style={{ bottom: palettePos.bottom, left: palettePos.left }}
          onClick={e => e.stopPropagation()}
        >
          <ThemeChooser currentTheme={note.color} onSelect={handleThemeSelect} />
        </div>,
        document.body,
      )}

      {/* More menu portal — escapes card overflow */}
      {moreOpen && morePos && createPortal(
        <div
          ref={moreMenuRef}
          className="note-card__more-menu note-card__more-menu--portal"
          style={{ bottom: morePos.bottom, right: morePos.right }}
          role="menu"
          onClick={e => e.stopPropagation()}
        >
          <button className="note-card__more-item" role="menuitem" onClick={handleDelete}>
            <Trash size={13} aria-hidden="true" />
            Delete
          </button>
          <button className="note-card__more-item" role="menuitem" onClick={e => { e.stopPropagation(); setMoreOpen(false); setMorePos(null); }}>
            <Tag size={13} aria-hidden="true" />
            Categorize
          </button>
          <button className="note-card__more-item" role="menuitem" onClick={e => { e.stopPropagation(); setMoreOpen(false); setMorePos(null); }}>
            <CheckSquare size={13} aria-hidden="true" />
            Show checkboxes
          </button>
          <button className="note-card__more-item" role="menuitem" onClick={handleDuplicate}>
            <Copy size={13} aria-hidden="true" />
            Duplicate
          </button>
        </div>,
        document.body,
      )}
    </article>
  );
}
