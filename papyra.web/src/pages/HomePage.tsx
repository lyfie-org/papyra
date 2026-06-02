import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import NoteComposer from '../components/NoteComposer';
import NoteGrid from '../components/NoteGrid';
import NoteEditorModal from '../components/NoteEditorModal';
import { useSignalR } from '../hooks/useSignalR';
import './HomePage.css';

export default function HomePage() {
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
  const isModalOpen = editingId !== undefined;

  const [searchParams, setSearchParams] = useSearchParams();

  // Open a note when the search palette navigates here with ?open=<id>
  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId) {
      setEditingId(openId);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useSignalR();

  return (
    <>
      <div className="home-page">
        <NoteComposer />
        <NoteGrid onNoteClick={id => setEditingId(id)} />
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
