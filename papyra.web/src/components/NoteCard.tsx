import { memo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Pin, Archive, ArchiveRestore, Share2, Trash2, RotateCcw, Hourglass,
} from 'lucide-react';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';
import { useTrashNote } from '../hooks/useTrashNote';
import { useSyncState } from '../hooks/useSync';
import { useShareSummary } from '../hooks/useShares';
import ShareDialog from './ShareDialog';
import CardMenu from './CardMenu';
import CardMedia from './CardMedia';
import LinkCards from './LinkCards';
import ShareBadge from './ShareBadge';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from '../lib/toastContext';
import MarkdownPreview from './MarkdownPreview';
import { patchNoteInCache } from '../lib/notesCache';
import { tintInkClass } from '../lib/noteColors';
import { useResolvedTheme } from '../hooks/useTheme';
import { useSettings } from '../hooks/useSettings';
import { purgeInfo } from '../lib/trashPurge';
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

function NoteCard({ note, variant = 'active', conflictId, conflictCount, onResolveConflict }: Props) {
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
  const [shareOpen, setShareOpen] = useState(false);
  // One request for the whole grid, not one per card.
  const { data: shareSummary } = useShareSummary();
  const shared = shareSummary?.find(s => s.noteId === note.id);

  const title = note.title.trim() || 'Untitled';
  // YAML `color` drives the card surface via a CSS var so the stylesheet can dim
  // the (always-light) pastel toward surface in dark mode instead of glaring.
  const style = note.color ? ({ '--note-tint': note.color } as CSSProperties) : undefined;
  const theme = useResolvedTheme();
  const className = `note-card${note.color ? ` note-card--colored${tintInkClass(note.color, theme)}` : ''}`;

  function invalidate() { queryClient.invalidateQueries({ queryKey: ['notes'] }); }

  // Persist a frontmatter patch, preserving every field the card isn't changing.
  async function patchNote(patch: Partial<Pick<Note, 'color' | 'pinned' | 'archived' | 'tags'>>) {
    patchNoteInCache(queryClient, note.id, patch);
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

  const card = (
    <article className={className} style={style} data-note-id={note.id}>
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
      {!note.secure && <CardMedia body={note.body} part="cover" />}
      <h3 className="note-card__title">{title}</h3>
      {/* A secure note's body never reaches the client, so there's no snippet to
          show — a redacted placeholder stands in until it's unlocked. */}
      {note.secure ? (
        <p className="note-card__snippet note-card__snippet--locked" aria-label="Locked note">
          ███ ██████ ████ ███████
        </p>
      ) : note.body.trim() && (
        <MarkdownPreview body={note.body} />
      )}
      {!note.secure && <CardMedia body={note.body} part="rest" />}
      {!note.secure && <LinkCards body={note.body} compact />}
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

      {variant === 'trashed' && <PurgeDate trashedAt={note.trashedAt} />}

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
              onClick={(e) => { stop(e); setShareOpen(true); }}
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
            <CardMenu note={note} onShare={() => setShareOpen(true)} />
          </>
        )}
      </div>
    </article>
  );

  return (
    <>
      {variant === 'trashed'
        ? <div className="note-card__link">{card}</div>
        : <Link to={`/note/${encodeURIComponent(note.id)}`} className="note-card__link">{card}</Link>}
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

// When Trash will erase this note for good, from the retention setting. Its own
// component so only trashed cards subscribe to the settings query.
function PurgeDate({ trashedAt }: { trashedAt?: string | null }) {
  const { data: settings } = useSettings();
  const info = purgeInfo(trashedAt, settings?.trashRetentionDays);
  if (!info) return null;
  return (
    <p
      className={`note-card__purge${info.soon ? ' note-card__purge--soon' : ''}`}
      title={info.title}
    >
      <Hourglass size={12} aria-hidden="true" />
      <span>{info.label}</span>
    </p>
  );
}

// Memoised: the desk renders hundreds of these, and a card only needs to redraw
// when its own note changes — not when a sibling is recoloured or pinned.
export default memo(NoteCard);
