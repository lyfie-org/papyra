import { useRef, useState, useEffect } from 'react';
import { Palette, PushPin, Bell, UserPlus, Image as ImageIcon, Archive, DotsThreeVertical, CheckCircle, Circle, Trash, Copy, Tag, CheckSquare } from '@phosphor-icons/react';
import type { NoteSummary } from '../types';
import { useUpdateNote, useDeleteNote } from '../hooks/useNotes';
import { resolveTheme } from '../lib/noteThemes';
import { useRelativeTime } from '../hooks/useRelativeTime';
import { useSelection } from '../context/SelectionContext';
import ThemeChooser from './ThemeChooser';
import './NoteCard.css';

interface NoteCardProps {
  note: NoteSummary;
  onClick: () => void;
}

const MAX_CONTENT_CHARS = 180;

export default function NoteCard({ note, onClick }: NoteCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const paletteRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const { isSelected, toggleSelect, hasSelection } = useSelection();

  const selected = isSelected(note.id);
  const { colorTheme, artTheme } = resolveTheme(note.color);
  const editedLabel = useRelativeTime(note.updatedAt ?? note.createdAt);

  const snippet = 'content' in note && typeof (note as { content?: string }).content === 'string'
    ? ((note as { content?: string }).content!.length > MAX_CONTENT_CHARS
        ? (note as { content?: string }).content!.slice(0, MAX_CONTENT_CHARS).trimEnd() + '…'
        : (note as { content?: string }).content!)
    : null;

  // Close more menu on outside click
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        !moreRef.current?.contains(e.target as Node) &&
        !moreMenuRef.current?.contains(e.target as Node)
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moreOpen]);

  const handleCardClick = () => {
    if (pickerOpen) { setPickerOpen(false); return; }
    if (moreOpen) { setMoreOpen(false); return; }
    onClick();
  };

  const handlePaletteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    setPickerOpen(v => !v);
  };

  const handleThemeSelect = (newTheme: string) => {
    updateNote.mutate({ id: note.id, req: { color: newTheme } });
    setPickerOpen(false);
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
    setMoreOpen(v => !v);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    deleteNote.mutate(note.id);
  };

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    // Duplicate via create with same title/color (content not in summary)
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
        {selected ? <CheckCircle size={20} className="note-card__select-icon--checked" /> : <Circle size={20} className="note-card__select-icon" />}
      </button>

      {/* Top-right pin */}
      <button
        className={['note-card__pin-btn', note.pinned ? 'note-card__pin-btn--visible' : ''].filter(Boolean).join(' ')}
        onClick={togglePin}
        aria-label={note.pinned ? "Unpin note" : "Pin note"}
      >
        <PushPin size={20} className={note.pinned ? 'note-card__pin-icon--pinned' : 'note-card__pin-icon'} aria-hidden="true" />
      </button>

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

      {/* Card toolbar — visible on hover */}
      <div className="note-card__toolbar">
        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Reminders">
          <Bell size={14} aria-hidden="true" />
        </button>
        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Collaborators">
          <UserPlus size={14} aria-hidden="true" />
        </button>

        <button
          ref={paletteRef}
          className={['note-card__toolbar-btn', pickerOpen ? 'note-card__toolbar-btn--active' : '']
            .filter(Boolean).join(' ')}
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
        <button className="note-card__toolbar-btn" onClick={e => e.stopPropagation()} aria-label="Archive">
          <Archive size={14} aria-hidden="true" />
        </button>

        <button
          ref={moreRef}
          className={['note-card__toolbar-btn', moreOpen ? 'note-card__toolbar-btn--active' : '']
            .filter(Boolean).join(' ')}
          onClick={handleMoreClick}
          aria-label="More options"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
        >
          <DotsThreeVertical size={14} aria-hidden="true" />
        </button>

        {pickerOpen && (
          <div
            className="note-card__theme-popover"
            onClick={e => e.stopPropagation()}
          >
            <ThemeChooser currentTheme={note.color} onSelect={handleThemeSelect} />
          </div>
        )}

        {moreOpen && (
          <div
            ref={moreMenuRef}
            className="note-card__more-menu"
            role="menu"
            onClick={e => e.stopPropagation()}
          >
            <button className="note-card__more-item" role="menuitem" onClick={handleDelete}>
              <Trash size={13} aria-hidden="true" />
              Delete
            </button>
            <button className="note-card__more-item" role="menuitem" onClick={e => { e.stopPropagation(); setMoreOpen(false); }}>
              <Tag size={13} aria-hidden="true" />
              Categorize
            </button>
            <button className="note-card__more-item" role="menuitem" onClick={e => { e.stopPropagation(); setMoreOpen(false); }}>
              <CheckSquare size={13} aria-hidden="true" />
              Show checkboxes
            </button>
            <button className="note-card__more-item" role="menuitem" onClick={handleDuplicate}>
              <Copy size={13} aria-hidden="true" />
              Duplicate
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
