import { useState } from 'react';
import { Pin, Palette, History, Archive, Trash2, ListTodo, Rewind, Maximize2 } from 'lucide-react';
import PalettePicker from './PalettePicker';
import './NoteToolbar.css';

// Frontmatter-action rail for the open note: Pin/Palette write into YAML, Trash
// deletes the .md. Fades in on editor hover (see NoteToolbar.css). Presentational
// only — the editor owns the actual mutations so they ride the live draft.
interface Props {
  pinned: boolean;
  color: string | null;
  isTodo: boolean;
  onTogglePin: () => void;
  onToggleTodo: () => void;
  onPickColor: (color: string | null) => void;
  onRecover: () => void;
  onTimeMachine: () => void;
  onFocus: () => void;
  onArchive: () => void;
  onTrash: () => void;
}

export default function NoteToolbar({
  pinned,
  color,
  isTodo,
  onTogglePin,
  onToggleTodo,
  onPickColor,
  onRecover,
  onTimeMachine,
  onFocus,
  onArchive,
  onTrash,
}: Props) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="note-toolbar">
      <button
        type="button"
        className={`note-toolbar__btn${pinned ? ' is-active' : ''}`}
        aria-pressed={pinned}
        aria-label={pinned ? 'Unpin note' : 'Pin note'}
        onClick={onTogglePin}
      >
        <Pin size={18} fill={pinned ? 'currentColor' : 'none'} />
      </button>

      <div className="note-toolbar__palette-wrap">
        <button
          type="button"
          className="note-toolbar__btn"
          aria-label="Change color"
          aria-expanded={paletteOpen}
          onClick={() => setPaletteOpen((o) => !o)}
        >
          <Palette size={18} />
        </button>
        {paletteOpen && (
          <PalettePicker
            active={color}
            onPick={(c) => {
              onPickColor(c);
              setPaletteOpen(false);
            }}
          />
        )}
      </div>

      <button
        type="button"
        className={`note-toolbar__btn${isTodo ? ' is-active' : ''}`}
        aria-pressed={isTodo}
        aria-label={isTodo ? 'Convert to note' : 'Convert to to-do'}
        onClick={onToggleTodo}
      >
        <ListTodo size={18} />
      </button>

      <button
        type="button"
        className="note-toolbar__btn"
        aria-label="File recovery"
        onClick={onRecover}
      >
        <History size={18} />
      </button>

      <button
        type="button"
        className="note-toolbar__btn"
        aria-label="Time machine"
        onClick={onTimeMachine}
      >
        <Rewind size={18} />
      </button>

      <button
        type="button"
        className="note-toolbar__btn"
        aria-label="Focus mode"
        onClick={onFocus}
      >
        <Maximize2 size={18} />
      </button>

      <button
        type="button"
        className="note-toolbar__btn"
        aria-label="Archive note"
        onClick={onArchive}
      >
        <Archive size={18} />
      </button>

      <button
        type="button"
        className="note-toolbar__btn note-toolbar__btn--danger"
        aria-label="Delete note"
        onClick={onTrash}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}
