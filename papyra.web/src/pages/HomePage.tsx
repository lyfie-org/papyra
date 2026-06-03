import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import NoteComposer from '../components/NoteComposer';
import NoteGrid from '../components/NoteGrid';
import SharedNotesSection from '../components/SharedNotesSection';
import NoteEditorModal from '../components/NoteEditorModal';
import './HomePage.css';

export default function HomePage() {
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
  const isModalOpen = editingId !== undefined;

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId) {
      setEditingId(openId);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // SignalR is now managed by SignalRProvider inside AppLayout — no local hook needed.

  return (
    <>
      <div className="home-page">
        <NoteComposer />
        <NoteGrid onNoteClick={id => setEditingId(id)} />
        <SharedNotesSection onNoteClick={id => setEditingId(id)} />
      </div>

      {isModalOpen && (
        <NoteEditorModal
          noteId={editingId ?? null}
          onClose={() => setEditingId(undefined)}
        />
      )}
    </>
  );
}
