import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { resolveSharedLink, useIncomingShares, useRequestAccess, useSharedPin } from '../hooks/useShares';
import SharedNoteActions from './SharedNoteActions';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useToast } from '../lib/toastContext';
import SharedNoteView, { type SharedNote } from './SharedNoteView';
import LoadingBar from './LoadingBar';
import './SharedNoteModal.css';

/**
 * A note shared with you, open over whatever page you are on (`?open=<shareId>`).
 * Opens in the note's live room (see SharedNoteView); viewers can ask for
 * edit access. Keyed under
 * ['shares', 'incoming'] so an approval pushed over the hub flips it editable.
 */
export default function SharedNoteModal({ shareId, onClose }: { shareId: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const queryClient = useQueryClient();
  const request = useRequestAccess();
  const { toast } = useToast();
  // Your own pin for it lives on the desk's list of shares.
  const { data: incoming } = useIncomingShares();
  const entry = incoming?.find((s) => s.shareId === shareId);
  const pinned = !!entry?.pinned;
  const sharedPin = useSharedPin();
  const [, setParams] = useSearchParams();

  // Under ['shares', 'incoming'] so an approval pushed over the hub (which
  // invalidates that prefix) refetches the open note and flips it editable.
  const { data: note, isError } = useQuery({
    queryKey: ['shares', 'incoming', shareId],
    queryFn: async (): Promise<SharedNote> => {
      const res = await fetch(`/api/shares/incoming/${shareId}`);
      if (!res.ok) throw new Error(res.status === 410 ? 'The owner locked this note.' : 'This note is no longer shared with you.');
      return res.json();
    },
    retry: false,
    // An editor is live on screen; a background refetch must not replace it
    // unless the access itself changed (the editor is keyed on that).
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    // An Escape a menu inside the note already used (it marks it handled) is
    // not a request to close the note.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function put(change: { body?: string; title?: string }) {
    const res = await fetch(`/api/shares/incoming/${shareId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
  }
  const save = (body: string) => put({ body });
  async function saveTitle(title: string) {
    await put({ title });
    // The desk card shows the new title too.
    void queryClient.invalidateQueries({ queryKey: ['shares', 'incoming'], exact: true });
  }

  // A [[link]] to another of the owner's notes opens it here — when they shared
  // that one with you too; otherwise say so (and who to ask).
  async function openLink(target: string) {
    const name = target.split('#')[0].trim();
    if (!name) return;
    try {
      const found = await resolveSharedLink(shareId, name);
      if (!found) {
        toast(`“${name}” isn’t shared with you.${note?.owner ? ` Ask @${note.owner} to share it.` : ''}`);
        return;
      }
      if (found.shareId === shareId) return;
      setParams((p) => { const next = new URLSearchParams(p); next.set('open', String(found.shareId)); next.delete('comment'); return next; });
    } catch (e) { toast((e as Error).message); }
  }

  async function requestEdit() {
    try {
      await request.mutateAsync({ shareId, access: 'edit' });
      await queryClient.invalidateQueries({ queryKey: ['shares', 'incoming', shareId] });
      toast(`Asked ${note?.owner ? `@${note.owner}` : 'the owner'} for edit access.`);
    } catch (e) { toast((e as Error).message); }
  }

  return (
    <div className="shared-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="shared-modal__inner" role="dialog" aria-modal="true" aria-label={note?.title || 'Shared note'}>
        <button type="button" className="shared-modal__close" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
        {isError && <p className="shared-modal__status">This note is no longer shared with you.</p>}
        {!isError && (note ? (
          <SharedNoteView
            note={note}
            onSave={save}
            onSaveTitle={saveTitle}
            onRequestEdit={requestEdit}
            pin={{ pinned, onToggle: () => sharedPin.mutate({ shareId, pinned: !pinned }) }}
            onClose={onClose}
            onOpenLink={(target) => void openLink(target)}
            actions={entry ? (
              <SharedNoteActions
                variant="note"
                // The open note is the freshest copy of its words and colour.
                share={{ ...entry, title: note.title, body: note.body, color: note.color, access: note.access }}
              />
            ) : undefined}
            mediaBase={`/api/shares/incoming/${shareId}/media`}
            // Signed in: join the note's live room (classic saves if the
            // collab engine is off).
            collab={{ shareId }}
          />
        ) : <LoadingBar label="Loading shared note" />)}
      </div>
    </div>
  );
}
