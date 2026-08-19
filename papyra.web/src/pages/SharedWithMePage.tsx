import { useState } from 'react';
import { X, Users } from 'lucide-react';
import { useIncomingShares } from '../hooks/useShares';
import SharedNoteView, { type SharedNote } from '../components/SharedNoteView';
import { SharedByBadge } from '../components/ShareBadge';
import EmptyState from '../components/EmptyState';
import './SharedWithMePage.css';

export default function SharedWithMePage() {
  const { data: incoming, isLoading } = useIncomingShares();
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState<SharedNote | null>(null);

  async function open(shareId: number) {
    setOpenId(shareId);
    setNote(null);
    const res = await fetch(`/api/shares/incoming/${shareId}`);
    if (res.ok) setNote(await res.json());
  }

  async function save(body: string) {
    if (openId == null) return;
    const res = await fetch(`/api/shares/incoming/${openId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
  }

  return (
    <section className="shared-with">
      <h1 className="page-title shared-with__title">Shared with me</h1>
      {isLoading && <p className="shared-with__status">Loading…</p>}
      {!isLoading && (incoming?.length ?? 0) === 0 && (
        <EmptyState
          icon={Users}
          title="Nothing shared with you yet"
          body="When someone on this server shares a note with you, it appears here. Depending on what they chose, you will either be able to read it or edit it alongside them."
          hint="Only the notes they picked are shared — nobody can see the rest of your notes, and you cannot see the rest of theirs."
        />
      )}

      <div className="shared-with__grid">
        {incoming?.map(s => (
          <button key={s.shareId} type="button" className="shared-with__card" onClick={() => void open(s.shareId)}>
            <span className="shared-with__card-title">{s.title.trim() || 'Untitled'}</span>
            <SharedByBadge owner={s.owner} access={s.access} />
          </button>
        ))}
      </div>

      {openId != null && (
        <div className="shared-with__modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenId(null); }}>
          <div className="shared-with__modal-inner">
            <button type="button" className="shared-with__close" aria-label="Close" onClick={() => setOpenId(null)}>
              <X size={18} />
            </button>
            {note ? (
              <SharedNoteView
                note={note}
                onSave={save}
                mediaUrl={(f) => `/api/shares/incoming/${openId}/media/${encodeURIComponent(f)}`}
              />
            ) : <p className="shared-with__status">Loading…</p>}
          </div>
        </div>
      )}
    </section>
  );
}
