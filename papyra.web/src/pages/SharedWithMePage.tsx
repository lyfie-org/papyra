import { useSearchParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import DraggableNoteGrid from '../components/DraggableNoteGrid';
import SharedNoteModal from '../components/SharedNoteModal';
import EmptyState from '../components/EmptyState';
import LoadingBar from '../components/LoadingBar';
import { useIncomingShares } from '../hooks/useShares';
import './NotesPage.css';

/**
 * Everything other people have shared with you, newest share first — nothing
 * else. The cards are the desk's own (same grid, same size), each saying whose
 * it is, when they shared it and what you may do with it. The same notes also
 * sit on your Notes desk, behind its "Shared with me" filter.
 */
export default function SharedWithMePage() {
  const { data: incoming, isLoading, isError } = useIncomingShares();
  const [params, setParams] = useSearchParams();
  const openShare = Number(params.get('open')) || null;

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="page-title notes-page__title">Shared with me</h1>
      </header>

      {isLoading && <LoadingBar label="Loading shared notes" />}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && (
        (incoming?.length ?? 0) === 0 ? (
          <EmptyState
            icon={Users}
            title="Nothing shared with you yet"
            body="When someone on this Papyra shares a note with you, it shows up here — and on your Notes page too — with who shared it, when, and whether you can edit it."
          />
        ) : (
          <DraggableNoteGrid notes={[]} shared={incoming ?? []} showSharedDate />
        )
      )}

      {openShare != null && (
        <SharedNoteModal
          shareId={openShare}
          onClose={() => setParams((p) => { const next = new URLSearchParams(p); next.delete('open'); return next; }, { replace: true })}
        />
      )}
    </section>
  );
}
