import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Pin, PinOff, Share2, Trash2, Archive, ArchiveRestore, RotateCcw, X, CheckCheck,
} from 'lucide-react';
import type { Note } from '../types/note';
import { bulkAction, idsWith, plural, type BulkAction } from '../lib/bulk';
import { useToast } from '../lib/toastContext';
import { useConfirm } from '../lib/confirmContext';
import { useSettings } from '../hooks/useSettings';
import { useSyncState } from '../hooks/useSync';
import BulkShareDialog from './BulkShareDialog';
import './BulkBar.css';

type Patch = Partial<Pick<Note, 'pinned' | 'archived' | 'trashed'>>;

/** Which page the selection is on — it decides what can be done to it. */
export type BulkMode = 'active' | 'archived' | 'trashed';

const PATCH: Record<Exclude<BulkAction, 'delete'>, Patch> = {
  pin: { pinned: true }, unpin: { pinned: false },
  archive: { archived: true }, unarchive: { archived: false },
  trash: { trashed: true }, untrash: { trashed: false },
};
const UNDO: Partial<Record<BulkAction, BulkAction>> = {
  pin: 'unpin', unpin: 'pin', archive: 'unarchive', unarchive: 'archive', trash: 'untrash', untrash: 'trash',
};
const DONE: Record<BulkAction, (what: string) => string> = {
  pin: (w) => `Pinned ${w}.`, unpin: (w) => `Unpinned ${w}.`,
  archive: (w) => `Archived ${w}.`, unarchive: (w) => `Unarchived ${w}.`,
  trash: (w) => `Moved ${w} to Trash.`, untrash: (w) => `Restored ${w}.`,
  delete: (w) => `Deleted ${w} for good.`,
};

/**
 * The toolbar a selection brings up. It floats at the bottom of the window,
 * where a thumb or a cursor already is, and offers what makes sense where the
 * selection is: on the desk pin, archive, share, delete; in the Archive
 * unarchive, share, delete; in Trash restore or delete for good.
 *
 * Every action shows its result at once (the cache is patched before the
 * request), is one request for the whole selection, and — except a permanent
 * delete, which asks first — offers Undo. A server refusal puts the truth back
 * with a refetch and says so.
 */
export default function BulkBar({ notes, total, onClear, onSelectAll, mode = 'active' }: {
  /** The selected notes, in display order. */
  notes: Note[];
  /** How many cards are on screen — for "Select all". */
  total: number;
  onClear: () => void;
  onSelectAll: () => void;
  mode?: BulkMode;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: settings } = useSettings();
  const { online } = useSyncState();
  const [sharing, setSharing] = useState<Note[] | null>(null);
  const [busy, setBusy] = useState(false);

  const ids = notes.map((n) => n.id);
  const count = notes.length;
  const noun = notes.every((n) => n.kind === 'todo') ? 'list' : 'note';
  const allPinned = count > 0 && notes.every((n) => n.pinned);
  const offline = online ? undefined : 'Needs a connection';

  function patchCache(targets: string[], action: BulkAction) {
    const set = new Set(targets);
    queryClient.setQueryData<Note[]>(['notes'], (prev) => (action === 'delete'
      ? prev?.filter((n) => !set.has(n.id))
      : prev?.map((n) => (set.has(n.id) ? { ...n, ...PATCH[action] } : n))));
  }

  async function run(action: BulkAction, targets: string[], opts: { undoable?: boolean } = {}) {
    patchCache(targets, action);
    try {
      const result = await bulkAction(targets, action);
      const changed = idsWith(result, 'changed');
      const missing = idsWith(result, 'notFound').length;
      const refused = idsWith(result, 'notTrashed').length;
      const head = DONE[action](plural(targets.length - missing - refused, noun));
      const tail = (missing ? ` ${plural(missing, noun)} couldn't be found.` : '')
        + (refused ? ` ${plural(refused, noun)} ${refused === 1 ? 'is' : 'are'} no longer in Trash, so ${refused === 1 ? 'it was' : 'they were'} kept.` : '');
      const undo = UNDO[action];
      toast(head + tail, opts.undoable && undo && changed.length
        ? { label: 'Undo', onClick: () => void run(undo, changed) }
        : undefined);
    } catch (e) {
      toast(`Couldn't ${action} ${plural(targets.length, noun)}: ${(e as Error).message}`);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
  }

  async function act(action: BulkAction, undoable = true) {
    if (busy || count === 0) return;
    setBusy(true);
    onClear();
    try { await run(action, ids, { undoable }); } finally { setBusy(false); }
  }

  async function remove() {
    if (busy || count === 0) return;
    // "Delete immediately" retention means no Trash to come back from: ask once
    // for the lot, then delete for good.
    if (settings?.trashRetentionDays === 0) {
      const ok = await confirm({
        title: `Delete ${plural(count, noun)}?`,
        body: 'Trash is set to remove notes immediately, so there is nothing to restore from. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      onClear();
      patchCache(ids, 'trash');
      const outcomes = await Promise.allSettled(ids.map(async (id) => {
        const res = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      }));
      const failed = outcomes.filter((o) => o.status === 'rejected').length;
      toast(failed
        ? `Deleted ${count - failed} of ${plural(count, noun)}; ${failed} couldn't be deleted.`
        : `Deleted ${plural(count, noun)} for good.`);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      setBusy(false);
      return;
    }
    await act('trash');
  }

  // Emptying part of Trash is the one action that can't be undone: always ask.
  async function purge() {
    if (busy || count === 0) return;
    const ok = await confirm({
      title: `Delete ${plural(count, noun)} for good?`,
      body: `${count === 1 ? 'It is' : 'They are'} removed from Trash permanently. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    });
    if (!ok) return;
    await act('delete', false);
  }

  const button = (label: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
    <button type="button" className={`bulk-bar__btn${danger ? ' bulk-bar__btn--danger' : ''}`}
      disabled={busy || !online} title={offline} aria-label={label} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );

  const bar = (
    <div className="bulk-bar" role="toolbar" aria-label={`${plural(count, noun)} selected`}>
      <button type="button" className="bulk-bar__close" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
        <X size={18} />
      </button>
      <span className="bulk-bar__count" aria-live="polite">
        <strong key={count} className="bulk-bar__num">{count}</strong> selected
      </span>
      {count < total && (
        <button type="button" className="bulk-bar__text" onClick={onSelectAll} title="Select all (Ctrl+A)">
          <CheckCheck size={16} /> All {total}
        </button>
      )}
      <span className="bulk-bar__sep" aria-hidden="true" />
      {mode === 'active' && (
        <>
          {button(allPinned ? 'Unpin' : 'Pin', allPinned ? <PinOff size={17} /> : <Pin size={17} />,
            () => void act(allPinned ? 'unpin' : 'pin'))}
          {button('Archive', <Archive size={17} />, () => void act('archive'))}
          {button('Share', <Share2 size={17} />, () => setSharing(notes))}
          {button('Delete', <Trash2 size={17} />, () => void remove(), true)}
        </>
      )}
      {mode === 'archived' && (
        <>
          {button('Unarchive', <ArchiveRestore size={17} />, () => void act('unarchive'))}
          {button('Share', <Share2 size={17} />, () => setSharing(notes))}
          {button('Delete', <Trash2 size={17} />, () => void remove(), true)}
        </>
      )}
      {mode === 'trashed' && (
        <>
          {button('Restore', <RotateCcw size={17} />, () => void act('untrash'))}
          {button('Delete forever', <Trash2 size={17} />, () => void purge(), true)}
        </>
      )}
    </div>
  );

  return (
    <>
      {createPortal(bar, document.body)}
      {sharing && (
        <BulkShareDialog
          notes={sharing}
          onClose={(done) => { setSharing(null); if (done) onClear(); }}
        />
      )}
    </>
  );
}
