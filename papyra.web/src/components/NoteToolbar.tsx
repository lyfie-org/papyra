import { useState } from 'react';
import { Pin, Palette, History, Archive, Trash2, Rewind, Maximize2, Lock, LockOpen } from 'lucide-react';
import PalettePicker from './PalettePicker';
import './NoteToolbar.css';
import { useSyncState } from '../hooks/useSync';

// Frontmatter-action rail for the open note: Pin/Palette write into YAML, Trash
// deletes the .md. Fades in on editor hover (see NoteToolbar.css). Presentational
// only — the editor owns the actual mutations so they ride the live draft.
interface Props {
  pinned: boolean;
  color: string | null;
  onTogglePin: () => void;
  onPickColor: (color: string | null) => void;
  onRecover: () => void;
  onTimeMachine: () => void;
  onFocus: () => void;
  onArchive: () => void;
  onTrash: () => void;
  /** Whether this note is locked into the vault. */
  secure: boolean;
  /**
   * False while the note is locked and not yet unlocked on this device. Clearing
   * the flag has to go through the same unlock as reading the body, or the lock
   * could simply be switched off by anyone at the keyboard.
   */
  canToggleSecure: boolean;
  onToggleSecure: () => void;
}

export default function NoteToolbar({
  pinned,
  color,
  onTogglePin,
  onPickColor,
  onRecover,
  onTimeMachine,
  onFocus,
  onArchive,
  onTrash,
  secure,
  canToggleSecure,
  onToggleSecure,
}: Props) {
  const { online } = useSyncState();
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

      {/* The note ⇄ to-do toggle is deliberately gone. `kind` decides which tab a
          note lives in, and flipping it on prose produced a "to-do" with no
          checkboxes that vanished from Notes into the To Do tab — the conversion
          defeated the point of the split. Notes are created as notes on the Notes
          tab, to-dos as to-dos on the To Do tab. */}

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

      {/* Locking is the only way into the Vault, and there was no control for it
          anywhere in the UI — the note had to be edited on disk. */}
      <button
        type="button"
        className={`note-toolbar__btn${secure ? ' is-active' : ''}`}
        aria-pressed={secure}
        aria-label={secure ? 'Unlock this note' : 'Lock this note'}
        disabled={!canToggleSecure}
        title={!canToggleSecure
          ? 'Unlock the note with your device first'
          : secure
            ? 'Unlock — the note leaves the Vault and becomes searchable again'
            : 'Lock — moves the note to the Vault, hidden until you unlock it'}
        onClick={onToggleSecure}
      >
        {secure ? <Lock size={18} /> : <LockOpen size={18} />}
      </button>

      <button
        type="button"
        className="note-toolbar__btn note-toolbar__btn--danger"
        aria-label="Delete note"
        // Deleting the .md is a server-side move with no offline equivalent.
        disabled={!online}
        title={online ? undefined : 'Needs a connection'}
        onClick={onTrash}
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}
