import { useState } from 'react';
import { Pin, Palette, History, Archive, Trash2 } from 'lucide-react';
import PalettePicker from './PalettePicker';
import './NoteToolbar.css';

// Frontmatter-action rail for the open note: Pin/Palette write into YAML, Trash
// deletes the .md. Fades in on editor hover (see NoteToolbar.css). Presentational
// only — the editor owns the actual mutations so they ride the live draft.
interface Props {
  pinned: boolean;
  color: string | null;
  onTogglePin: () => void;
  onPickColor: (color: string | null) => void;
  onRecover: () => void;
  onArchive: () => void;
  onTrash: () => void;
}

export default function NoteToolbar({
  pinned,
  color,
  onTogglePin,
  onPickColor,
  onRecover,
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
        className="note-toolbar__btn"
        aria-label="File recovery"
        onClick={onRecover}
      >
        <History size={18} />
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
