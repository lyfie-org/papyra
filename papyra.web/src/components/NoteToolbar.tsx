import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Palette, History, Archive, Trash2, Lock, LockOpen, Share2, Type } from 'lucide-react';
import PalettePicker from './PalettePicker';
import './NoteToolbar.css';
import { useSyncState } from '../hooks/useSync';
import { useDismiss } from '../hooks/useDismiss';

// Frontmatter-action rail for the open note: Palette writes into YAML, Trash
// deletes the .md. Pin and focus mode sit at the sheet's top right instead.
// Fades in on editor hover (see NoteToolbar.css). Presentational only — the editor owns the actual mutations so they ride the live draft.
interface Props {
  /** Whether the formatting toolbar above the note body is showing. */
  formattingOpen: boolean;
  onFormatting: () => void;
  color: string | null;
  onPickColor: (color: string | null) => void;
  /** Version history — one mode that replaced "time machine" + "file recovery". */
  historyOpen: boolean;
  onHistory: () => void;
  onArchive: () => void;
  onShare: () => void;
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
  /** The comments button, when comments are on for this note. */
  comments?: ReactNode;
  /**
   * Focus mode: only the writing tools (formatting, colour, history, comments,
   * share), always visible. Archive, lock and delete wait until you leave it.
   */
  focus?: boolean;
}

export default function NoteToolbar({
  formattingOpen,
  onFormatting,
  color,
  onPickColor,
  historyOpen,
  onHistory,
  onArchive,
  onShare,
  onTrash,
  secure,
  canToggleSecure,
  onToggleSecure,
  comments,
  focus = false,
}: Props) {
  const { online } = useSyncState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The swatches close on a click anywhere else, or Escape — like every popover.
  const paletteRef = useRef<HTMLDivElement>(null);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useDismiss(paletteRef, paletteOpen, closePalette);

  return (
    <div className={`note-toolbar${focus ? ' note-toolbar--focus' : ''}`}>
      {/* Shows the formatting toolbar (headings, lists, table, link a note,
          mention, embeds…) above the body. Settings → Appearance can keep it
          open on every note. */}
      <button
        type="button"
        className={`note-toolbar__btn${formattingOpen ? ' is-active' : ''}`}
        aria-pressed={formattingOpen}
        aria-label={formattingOpen ? 'Hide formatting toolbar' : 'Show formatting toolbar'}
        title={formattingOpen ? 'Hide formatting toolbar' : 'Show formatting toolbar'}
        onClick={onFormatting}
      >
        <Type size={18} />
      </button>

      <div className="note-toolbar__palette-wrap" ref={paletteRef}>
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
        className={`note-toolbar__btn${historyOpen ? ' is-active' : ''}`}
        aria-label="Version history"
        aria-pressed={historyOpen}
        title="Version history"
        onClick={onHistory}
      >
        <History size={18} />
      </button>

      {comments}

      {!focus && (
        <button
          type="button"
          className="note-toolbar__btn"
          aria-label="Archive note"
          onClick={onArchive}
        >
          <Archive size={18} />
        </button>
      )}

      {/* Sharing was reachable only from the card. Opening a note to work on it
          and then wanting to send it to someone is the ordinary order of events,
          and it used to mean closing the note first to find its card again. */}
      <button
        type="button"
        className="note-toolbar__btn"
        aria-label="Share note"
        // Creating a share is a server-side write with no offline equivalent.
        disabled={!online}
        title={online ? 'Share this note' : 'Needs a connection'}
        onClick={onShare}
      >
        <Share2 size={18} />
      </button>

      {/* Locking is the only way into the Vault, and there was no control for it
          anywhere in the UI — the note had to be edited on disk. */}
      {!focus && (
        <>
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
        </>
      )}
    </div>
  );
}
