import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Copy, Download, Link2, Lock, LockOpen, MoreHorizontal, Pin, PinOff, Share2, Trash2 } from 'lucide-react';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';
import { patchNoteInCache } from '../lib/notesCache';
import { vaultFetch } from '../lib/vault';
import { useToast } from '../lib/toastContext';
import { useSyncState } from '../hooks/useSync';
import { usePopoverMenu } from '../hooks/usePopoverMenu';
import { useAuth } from '../hooks/useAuth';
import { noteLink } from '../hooks/useShares';
import './CardMenu.css';

/** A note as the .md file Papyra would write: YAML front matter, then the body. */
function toMarkdown(note: Note): string {
  const q = (s: string) => JSON.stringify(s);
  const fm = [
    '---',
    `title: ${q(note.title)}`,
    ...(note.tags.length ? [`tags: [${note.tags.map(q).join(', ')}]`] : []),
    ...(note.color ? [`color: ${q(note.color)}`] : []),
    ...(note.kind && note.kind !== 'note' ? [`kind: ${note.kind}`] : []),
    '---',
    '',
  ];
  return `${fm.join('\n')}${note.body}`;
}

function fileName(note: Note): string {
  const base = (note.title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base.slice(0, 80) || 'Untitled'}.md`;
}

/**
 * The "…" menu on a desk card (notes and to-do lists).
 *
 * The list is portalled to <body> and placed against the window, not the card:
 * it used to hang off the card's own box, so on a card near the top or bottom
 * of the screen it opened out of view, and it slid under the neighbouring
 * card's pin. It now opens below the button when there's room and above when
 * there isn't, and is kept inside the window sideways.
 */
export default function CardMenu({ note, onShare, onArchive, onDelete, triggerClassName }: {
  note: Note;
  onShare: () => void;
  /** Fold Archive and Delete into the menu (a to-do card has no action rail). */
  onArchive?: () => unknown;
  onDelete?: () => unknown;
  triggerClassName?: string;
}) {
  const { open, pos, triggerRef, menuRef, toggle, onMenuKey, run } = usePopoverMenu();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { online } = useSyncState();

  async function togglePin() {
    const pinned = !note.pinned;
    patchNoteInCache(queryClient, note.id, { pinned });
    await putNote(note.id, {
      title: note.title, tags: note.tags, color: note.color, pinned,
      archived: note.archived, kind: note.kind, body: note.body,
    }, note.updated);
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
  }

  // Lock / unlock, as the editor's toolbar does it. A locked card has no body
  // (the server withholds it), and an empty body is kept as-is by the server.
  async function toggleLock() {
    const next = !note.secure;
    let res: Response;
    try {
      res = await vaultFetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: note.title, tags: note.tags, color: note.color, pinned: note.pinned,
          archived: note.archived, kind: note.kind, body: note.secure ? '' : note.body, secure: next,
        }),
      });
    } catch {
      toast('Couldn’t change the lock — the server is unreachable.');
      return;
    }
    if (res.status === 409) {
      toast('Set a vault PIN before locking notes.', {
        label: 'Set PIN', onClick: () => navigate('/settings?tab=security&s=vault-pin'),
      });
      return;
    }
    if (res.status === 401) {
      toast('Open your vault to unlock this note.', { label: 'Open vault', onClick: () => navigate('/vault') });
      return;
    }
    if (!res.ok) { toast('Couldn’t change the lock.'); return; }
    patchNoteInCache(queryClient, note.id, { secure: next });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    toast(next ? 'Note locked and moved to the Vault.' : 'Note unlocked — it is back with your other notes.');
  }

  async function duplicate() {
    const title = note.title.trim();
    await putNote(crypto.randomUUID(), {
      title: title ? `${note.title} copy` : '',
      tags: note.tags, color: note.color, pinned: false, archived: false, kind: note.kind, body: note.body,
    });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    toast('Copy made.');
  }

  async function copyLink() {
    // `/n/<you>/<id>`: opens the note for you, and for anyone you share it with.
    const url = auth.user ? noteLink(auth.user.username, note.id) : `${window.location.origin}/note/${encodeURIComponent(note.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — it opens for anyone signed in who can see this note.');
    } catch {
      toast('Couldn’t reach the clipboard.');
    }
  }

  function download() {
    const blob = new Blob([toMarkdown(note)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(note);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const offline = online ? undefined : 'Needs a connection';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? 'note-card__action'}
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="card-menu"
          role="menu"
          aria-label={`Actions for “${note.title.trim() || 'Untitled'}”`}
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
          onKeyDown={onMenuKey}
          // Portalled, but React still bubbles to the card: keep a press here
          // from starting a card drag or opening the note.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(togglePin)}>
            {note.pinned ? <PinOff size={15} /> : <Pin size={15} />} {note.pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button type="button" role="menuitem" className="card-menu__item" disabled={!online} title={offline}
            onClick={run(toggleLock)}>
            {note.secure ? <LockOpen size={15} /> : <Lock size={15} />} {note.secure ? 'Unlock note' : 'Lock in Vault'}
          </button>
          <button type="button" role="menuitem" className="card-menu__item" disabled={!online} title={offline}
            onClick={run(onShare)}>
            <Share2 size={15} /> Share…
          </button>
          <div className="card-menu__sep" role="separator" />
          <button type="button" role="menuitem" className="card-menu__item" disabled={note.secure}
            title={note.secure ? 'Unlock the note to copy it' : undefined} onClick={run(duplicate)}>
            <Copy size={15} /> Make a copy
          </button>
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(copyLink)}>
            <Link2 size={15} /> Copy link
          </button>
          <button type="button" role="menuitem" className="card-menu__item" disabled={note.secure}
            title={note.secure ? 'Unlock the note to download it' : undefined} onClick={run(download)}>
            <Download size={15} /> Download .md
          </button>
          {(onArchive || onDelete) && <div className="card-menu__sep" role="separator" />}
          {onArchive && (
            <button type="button" role="menuitem" className="card-menu__item" onClick={run(onArchive)}>
              <Archive size={15} /> Archive
            </button>
          )}
          {onDelete && (
            <button type="button" role="menuitem" className="card-menu__item card-menu__item--danger"
              disabled={!online} title={offline} onClick={run(onDelete)}>
              <Trash2 size={15} /> Move to Trash
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
