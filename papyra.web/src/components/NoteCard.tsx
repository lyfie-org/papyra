import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Pin, Archive, ArchiveRestore, Share2, Trash2, RotateCcw,
  MoreHorizontal, Copy, Link2,
} from 'lucide-react';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';
import { useTrashNote } from '../hooks/useTrashNote';
import { useSyncState } from '../hooks/useSync';
import { useShareSummary } from '../hooks/useShares';
import ShareDialog from './ShareDialog';
import ShareBadge from './ShareBadge';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from '../lib/toastContext';
import { snippet } from '../lib/plainText';
import { originState } from '../lib/noteLink';
import './NoteCard.css';


export type CardVariant = 'active' | 'archived' | 'trashed';

interface Props {
  note: Note;
  variant?: CardVariant;
  // First unresolved conflict copy shadowing this note, if any, + how many there are.
  conflictId?: string;
  conflictCount?: number;
  onResolveConflict?: (conflictId: string) => void;
}

// Swallow a click on a card action so it doesn't bubble up to the Link (which
// would navigate into the note).
function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

export default function NoteCard({ note, variant = 'active', conflictId, conflictCount, onResolveConflict }: Props) {
  const location = useLocation();
  const { toast } = useToast();
  // Only unrecoverable deletes ask. Everything else is done and reported.
  const [confirming, setConfirming] = useState<'forever' | null>(null);
  const queryClient = useQueryClient();
  const trashNote = useTrashNote();
  // Trash/restore/delete are server-side moves with no offline equivalent — the
  // outbox only carries note writes. Rather than firing a fetch that rejects
  // into a void, the controls say plainly that they need a connection.
  const { online } = useSyncState();
  const offlineHint = online ? undefined : 'Needs a connection';
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // One request for the whole grid, not one per card.
  const { data: shareSummary } = useShareSummary();
  const shared = shareSummary?.find(s => s.noteId === note.id);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const title = note.title.trim() || 'Untitled';
  // YAML `color` drives the card surface via a CSS var so the stylesheet can dim
  // the (always-light) pastel toward surface in dark mode instead of glaring.
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const className = `note-card${note.color ? ' note-card--colored' : ''}`;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  function invalidate() { queryClient.invalidateQueries({ queryKey: ['notes'] }); }

  // Persist a frontmatter patch, preserving every field the card isn't changing.
  async function patchNote(patch: Partial<Note>) {
    await putNote(note.id, {
      title: note.title, tags: note.tags, color: note.color,
      pinned: note.pinned, archived: note.archived, kind: note.kind, body: note.body,
      ...patch,
    }, note.updated);
    invalidate();
  }

  async function action(path: string, method = 'POST') {
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}${path}`, { method });
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} failed: ${res.status}`);
    invalidate();
  }

  // Soft-delete → trash, through the shared rule. It owns the Undo and the
  // "Trash removes notes immediately" case, so the card and the open editor
  // cannot disagree about what deleting a note does.
  async function trash() {
    await trashNote(note);
  }

  function deleteForever() { setConfirming('forever'); }

  async function reallyDelete() {
    setConfirming(null);
    await action('', 'DELETE');
    toast('Note deleted for good.');
  }

  async function duplicate() {
    const id = crypto.randomUUID();
    await putNote(id, {
      title: title === 'Untitled' ? '' : `${note.title} copy`,
      tags: note.tags, color: note.color, pinned: false, archived: false, kind: note.kind, body: note.body,
    });
    invalidate();
  }

  async function copyLink() {
    const url = `${window.location.origin}/note/${encodeURIComponent(note.id)}`;
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
  }

  const card = (
    <article className={className} style={style}>
      {/* Keep-style pin: hangs off the top-right corner, half over the card. Only
          on active notes; always shown while pinned, else revealed on hover. */}
      {variant === 'active' && (
        <button
          type="button"
          className={`note-card__pin${note.pinned ? ' note-card__pin--active' : ''}`}
          aria-pressed={note.pinned}
          aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
          onClick={(e) => { stop(e); void patchNote({ pinned: !note.pinned }); }}
        >
          <Pin size={15} fill={note.pinned ? 'currentColor' : 'none'} />
        </button>
      )}

      {conflictId && (
        <button
          type="button"
          className="note-card__conflict"
          onClick={(e) => { stop(e); onResolveConflict?.(conflictId); }}
        >
          <AlertTriangle size={14} />
          {conflictCount && conflictCount > 1
            ? `${conflictCount} sync conflicts — resolve`
            : 'Sync conflict — resolve'}
        </button>
      )}
      <h3 className="note-card__title">{title}</h3>
      {/* A secure note's body never reaches the client, so there's no snippet to
          show — a redacted placeholder stands in until it's unlocked. */}
      {note.secure ? (
        <p className="note-card__snippet note-card__snippet--locked" aria-label="Locked note">
          ███ ██████ ████ ███████
        </p>
      ) : note.body.trim() && (
        <p className="note-card__snippet">{snippet(note.body)}</p>
      )}
      {note.tags.length > 0 && (
        <ul className="note-card__tags">
          {note.tags.map(tag => (
            <li key={tag} className="note-card__tag">{tag}</li>
          ))}
        </ul>
      )}

      {/* Who else can read this. On the card rather than inside the share dialog
          because "my notes are mine" is the promise, and an exception to it
          should be visible without going looking for it. */}
      {shared && <ShareBadge summary={shared} />}

      <div className="note-card__actions">
        {variant === 'trashed' ? (
          <>
            <button
              type="button" className="note-card__action" aria-label="Restore note"
              disabled={!online} title={offlineHint}
              onClick={(e) => { stop(e); void action('/untrash'); }}
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button" className="note-card__action note-card__action--danger" aria-label="Delete forever"
              disabled={!online} title={offlineHint}
              onClick={(e) => { stop(e); void deleteForever(); }}
            >
              <Trash2 size={16} />
            </button>
          </>
        ) : (
          <>
            {variant === 'archived' ? (
              <button
                type="button" className="note-card__action" aria-label="Unarchive note"
                onClick={(e) => { stop(e); void patchNote({ archived: false }); }}
              >
                <ArchiveRestore size={16} />
              </button>
            ) : (
              <button
                type="button" className="note-card__action" aria-label="Archive note"
                onClick={(e) => { stop(e); void patchNote({ archived: true }); }}
              >
                <Archive size={16} />
              </button>
            )}
            <button
              type="button" className="note-card__action" aria-label="Share note"
              disabled={!online} title={offlineHint}
              onClick={(e) => { stop(e); setMenuOpen(false); setShareOpen(true); }}
            >
              <Share2 size={16} />
            </button>
            <button
              type="button" className="note-card__action note-card__action--danger" aria-label="Delete note"
              disabled={!online} title={offlineHint}
              onClick={(e) => { stop(e); void trash(); }}
            >
              <Trash2 size={16} />
            </button>
            <div className="note-card__menu-wrap" ref={menuRef}>
              <button
                type="button" className="note-card__action" aria-label="More actions"
                aria-expanded={menuOpen}
                onClick={(e) => { stop(e); setMenuOpen(o => !o); }}
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <div className="note-card__menu" role="menu">
                  <button
                    type="button" role="menuitem" className="note-card__menu-item"
                    onClick={(e) => { stop(e); setMenuOpen(false); void duplicate(); }}
                  >
                    <Copy size={15} /> Duplicate
                  </button>
                  <button
                    type="button" role="menuitem" className="note-card__menu-item"
                    onClick={(e) => { stop(e); setMenuOpen(false); void copyLink(); setShareOpen(true); }}
                  >
                    <Link2 size={15} /> Copy link
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );

  return (
    <>
      {variant === 'trashed'
        ? <div className="note-card__link">{card}</div>
        : <Link to={`/note/${encodeURIComponent(note.id)}`} state={originState(location)} className="note-card__link">{card}</Link>}
      {confirming && (
        <ConfirmDialog
          destructive
          title="Delete for good?"
          body="This removes the note from Trash permanently. It cannot be recovered."
          confirmLabel="Delete"
          onConfirm={() => void reallyDelete()}
          onCancel={() => setConfirming(null)}
        />
      )}

      {shareOpen && <ShareDialog note={note} onClose={() => setShareOpen(false)} />}
    </>
  );
}
