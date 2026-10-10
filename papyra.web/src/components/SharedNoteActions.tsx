import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Link2, MoreHorizontal, Palette, Pin, PinOff, Plus, Share2, Tag, X } from 'lucide-react';
import {
  noteLink, useReshare, useSharedColor, useSharedPin, useSharedTags, type IncomingShare,
} from '../hooks/useShares';
import { usePopoverMenu } from '../hooks/usePopoverMenu';
import { useDismiss } from '../hooks/useDismiss';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { putNote } from '../lib/notesApi';
import { useToast } from '../lib/toastContext';
import PalettePicker from './PalettePicker';
import TagEditor from './TagEditor';
import UserPicker from './UserPicker';
import './CardMenu.css';
import './ShareDialog.css';
import './SharedNoteActions.css';

function stop(e: React.SyntheticEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/** A shared note as the .md file Papyra would write — the owner's note, your tags. */
function toMarkdown(share: Pick<IncomingShare, 'title' | 'body' | 'color' | 'tags'>): string {
  const q = (s: string) => JSON.stringify(s);
  const tags = share.tags ?? [];
  return [
    '---',
    `title: ${q(share.title)}`,
    ...(tags.length ? [`tags: [${tags.map(q).join(', ')}]`] : []),
    ...(share.color ? [`color: ${q(share.color)}`] : []),
    '---',
    '',
  ].join('\n') + share.body;
}

function fileName(title: string): string {
  const base = (title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base.slice(0, 80) || 'Untitled'}.md`;
}

export type SharedActionsShare = Pick<
  IncomingShare, 'shareId' | 'noteId' | 'owner' | 'title' | 'body' | 'color' | 'access' | 'pinned' | 'tags'
>;

/**
 * What you can do with a note someone shared with you, in the same places and
 * the same look as on a note of your own: on its card (revealed on hover) and
 * at the foot of the open note.
 *
 * Anyone it is shared with can pin it and tag it on their own desk, make a copy
 * of it, copy its link and download it. Someone who can edit it can also change
 * its colour — colour belongs to the note, so its owner and everyone else see
 * the change — and share it onward (it stays the owner's note).
 */
export default function SharedNoteActions({ share, variant }: { share: SharedActionsShare; variant: 'card' | 'note' }) {
  const canEdit = share.access === 'edit';
  const [sharing, setSharing] = useState(false);
  const [tagging, setTagging] = useState(false);
  const btn = variant === 'card' ? 'note-card__action' : 'note-toolbar__btn';
  const size = variant === 'card' ? 16 : 18;

  return (
    <>
      {canEdit && <ColorButton share={share} className={btn} size={size} variant={variant} />}
      {canEdit && (
        <button type="button" className={btn} aria-label="Share note" title="Share with someone else"
          onClick={(e) => { stop(e); setSharing(true); }}>
          <Share2 size={size} />
        </button>
      )}
      <SharedMenu share={share} className={btn} size={size} onTags={() => setTagging(true)} />
      {sharing && <ReshareDialog share={share} onClose={() => setSharing(false)} />}
      {tagging && <SharedTagsDialog share={share} onClose={() => setTagging(false)} />}
    </>
  );
}

function ColorButton({ share, className, size, variant }: {
  share: SharedActionsShare; className: string; size: number; variant: 'card' | 'note';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrap, open, close);
  const color = useSharedColor();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return (
    // Inside the card's link: a click on a swatch must neither open the note
    // nor let the browser follow the link.
    <div className={`shared-actions__palette shared-actions__palette--${variant}`} ref={wrap}
      onClick={stop} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className={className} aria-label="Change color" aria-expanded={open}
        title="Change colour (everyone with this note sees it)"
        onClick={(e) => { stop(e); setOpen((o) => !o); }}>
        <Palette size={size} />
      </button>
      {open && (
        <PalettePicker
          active={share.color}
          onPick={(c) => {
            setOpen(false);
            color.mutate({ shareId: share.shareId, color: c }, {
              onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['shares', 'incoming', share.shareId] }),
              onError: (e) => toast((e as Error).message),
            });
          }}
        />
      )}
    </div>
  );
}

function SharedMenu({ share, className, size, onTags }: {
  share: SharedActionsShare; className: string; size: number; onTags: () => void;
}) {
  const { open, pos, triggerRef, menuRef, toggle, onMenuKey, run } = usePopoverMenu();
  const pin = useSharedPin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pinned = !!share.pinned;
  const title = share.title.trim() || 'Untitled';

  async function duplicate() {
    // Into your own notes: yours to change, keep and organise. Its attachments
    // stay the owner's.
    await putNote(crypto.randomUUID(), {
      title: share.title.trim() ? `${share.title} copy` : '',
      tags: share.tags ?? [], color: share.color, pinned: false, archived: false, kind: 'note', body: share.body,
    });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    toast('Copy made in your notes.');
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(noteLink(share.owner, share.noteId));
      toast('Link copied — it opens for the owner and everyone it’s shared with.');
    } catch {
      toast('Couldn’t reach the clipboard.');
    }
  }

  function download() {
    const blob = new Blob([toMarkdown(share)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(share.title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <>
      <button ref={triggerRef} type="button" className={className} aria-label="More actions" title="More actions"
        aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal size={size} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="card-menu"
          role="menu"
          aria-label={`Actions for “${title}”`}
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
          onKeyDown={onMenuKey}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="card-menu__item"
            onClick={run(() => pin.mutate({ shareId: share.shareId, pinned: !pinned }))}>
            {pinned ? <PinOff size={15} /> : <Pin size={15} />} {pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(onTags)}>
            <Tag size={15} /> Your tags…
          </button>
          <div className="card-menu__sep" role="separator" />
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(duplicate)}>
            <Copy size={15} /> Make a copy
          </button>
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(copyLink)}>
            <Link2 size={15} /> Copy link
          </button>
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(download)}>
            <Download size={15} /> Download .md
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A small dialog, portalled out of the card (whose transform would trap `fixed`). */
function Dialog({ label, title, onClose, children }: {
  label: string; title: string; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  return createPortal(
    <div
      className="share"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
    >
      <div ref={ref} className="share__dialog shared-actions__dialog" role="dialog" aria-modal="true" aria-label={label}>
        <header className="share__head">
          <h2 className="share__title">{title}</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ReshareDialog({ share, onClose }: { share: SharedActionsShare; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const reshare = useReshare();
  const title = share.title.trim() || 'Untitled';

  async function add() {
    setError(null);
    const name = username.trim().replace(/^@/, '');
    if (!name) return;
    try {
      const result = await reshare.mutateAsync({ shareId: share.shareId, granteeUsername: name, access });
      const role = result.access === 'edit' ? 'can edit' : 'can view';
      setDone((d) => [...d, result.status === 'alreadyShared'
        ? `@${result.grantee} already has it (${role}).`
        : `@${result.grantee} ${role} now.`]);
      setUsername('');
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <Dialog label="Share note" title={`Share “${title}”`} onClose={onClose}>
      <p className="shared-actions__hint">It stays @{share.owner}’s note: they see who you added, and can change or remove it.</p>
      {error && <p className="share__error" role="alert">{error}</p>}
      <div className="share__invite">
        <UserPicker value={username} onChange={setUsername} onSubmit={() => void add()} exclude={new Set([share.owner.toLowerCase()])} />
        <select aria-label="Access" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
          <option value="view">Can view</option>
          <option value="edit">Can edit</option>
        </select>
        <button type="button" className="share__btn" disabled={reshare.isPending} onClick={() => void add()}>
          <Plus size={15} /> Add
        </button>
      </div>
      {done.length > 0 && (
        <ul className="shared-actions__done" role="status">
          {done.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </Dialog>
  );
}

function SharedTagsDialog({ share, onClose }: { share: SharedActionsShare; onClose: () => void }) {
  const tags = useSharedTags();
  const { toast } = useToast();
  const title = share.title.trim() || 'Untitled';
  return (
    <Dialog label="Your tags" title={`Your tags for “${title}”`} onClose={onClose}>
      <p className="shared-actions__hint">Only you see these. @{share.owner}’s own tags are theirs.</p>
      <TagEditor
        tags={share.tags ?? []}
        onChange={(next) => tags.mutateAsync({ shareId: share.shareId, tags: next }).then(() => undefined, (e) => toast((e as Error).message))}
      />
    </Dialog>
  );
}
