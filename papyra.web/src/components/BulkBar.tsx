import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff, Share2, Trash2, Archive, X, CheckCheck } from 'lucide-react';
import type { Note } from '../types/note';
import { bulkAction, idsWith, plural, type BulkAction } from '../lib/bulk';
import { useToast } from '../lib/toastContext';
import { useConfirm } from '../lib/confirmContext';
import { useSettings } from '../hooks/useSettings';
import { useSyncState } from '../hooks/useSync';
import BulkShareDialog from './BulkShareDialog';
import './BulkBar.css';

type Patch = Partial<Pick<Note, 'pinned' | 'archived' | 'trashed'>>;

const PATCH: Record<BulkAction, Patch> = {
  pin: { pinned: true }, unpin: { pinned: false },
  archive: { archived: true }, unarchive: { archived: false },
  trash: { trashed: true }, untrash: { trashed: false },
};
const UNDO: Record<BulkAction, BulkAction> = {
  pin: 'unpin', unpin: 'pin', archive: 'unarchive', unarchive: 'archive', trash: 'untrash', untrash: 'trash',
};
const DONE: Record<BulkAction, (what: string) => string> = {
  pin: (w) => `Pinned ${w}.`, unpin: (w) => `Unpinned ${w}.`,
  archive: (w) => `Archived ${w}.`, unarchive: (w) => `Unarchived ${w}.`,
  trash: (w) => `Moved ${w} to Trash.`, untrash: (w) => `Restored ${w}.`,
};

/**
 * The toolbar a selection brings up: pin/unpin, archive, share, delete. It
 * floats at the bottom of the window, where a thumb or a cursor already is.
 *
 * Every action shows its result at once (the cache is patched before the
 * request), is one request for the whole selection, and offers Undo. A server
 * refusal puts the truth back with a refetch and says so.
 */
export default function BulkBar({ notes, total, onClear, onSelectAll }: {
  /** The selected notes, in display order. */
  notes: Note[];
  /** How many cards are on screen — for "Select all". */
  total: number;
  onClear: () => void;
  onSelectAll: () => void;
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

  function patchCache(targets: string[], patch: Patch) {
    const set = new Set(targets);
    queryClient.setQueryData<Note[]>(['notes'], (prev) =>
      prev?.map((n) => (set.has(n.id) ? { ...n, ...patch } : n)));
  }

  async function run(action: BulkAction, targets: string[], opts: { undoable?: boolean } = {}) {
    patchCache(targets, PATCH[action]);
    try {
      const result = await bulkAction(targets, action);
      const changed = idsWith(result, 'changed');
      const missing = idsWith(result, 'notFound').length;
      const head = DONE[action](plural(targets.length - missing, noun));
      const tail = missing ? ` ${plural(missing, noun)} couldn't be found.` : '';
      toast(head + tail, opts.undoable && changed.length
        ? { label: 'Undo', onClick: () => void run(UNDO[action], changed) }
        : undefined);
    } catch (e) {
      toast(`Couldn't ${action} ${plural(targets.length, noun)}: ${(e as Error).message}`);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
  }

  async function act(action: BulkAction) {
    if (busy || count === 0) return;
    setBusy(true);
    onClear();
    try { await run(action, ids, { undoable: true }); } finally { setBusy(false); }
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
      patchCache(ids, { trashed: true });
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
      <button type="button" className="bulk-bar__btn" disabled={busy || !online} title={offline}
        aria-label={allPinned ? 'Unpin' : 'Pin'} onClick={() => void act(allPinned ? 'unpin' : 'pin')}>
        {allPinned ? <PinOff size={17} /> : <Pin size={17} />}
        <span>{allPinned ? 'Unpin' : 'Pin'}</span>
      </button>
      <button type="button" className="bulk-bar__btn" disabled={busy || !online} title={offline}
        aria-label="Archive" onClick={() => void act('archive')}>
        <Archive size={17} /><span>Archive</span>
      </button>
      <button type="button" className="bulk-bar__btn" disabled={busy || !online} title={offline}
        aria-label="Share" onClick={() => setSharing(notes)}>
        <Share2 size={17} /><span>Share</span>
      </button>
      <button type="button" className="bulk-bar__btn bulk-bar__btn--danger" disabled={busy || !online} title={offline}
        aria-label="Delete" onClick={() => void remove()}>
        <Trash2 size={17} /><span>Delete</span>
      </button>
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
