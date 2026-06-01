import { useState } from 'react';
import { Plus } from 'lucide-react';
import NoteGrid from './components/NoteGrid';
import NoteEditorModal from './components/NoteEditorModal';
import { useSignalR } from './hooks/useSignalR';
import './App.css';

export default function App() {
  // null  = create new note
  // string = edit existing note by id
  // undefined = modal closed
  const [editingId, setEditingId] = useState<string | null | undefined>(
    undefined,
  );

  const isModalOpen = editingId !== undefined;

  useSignalR();

  return (
    <main>
      <header className="app-header">
        <h1 className="app-title">Papyra</h1>
        <button
          className="btn-new-note"
          onClick={() => setEditingId(null)}
          aria-label="New note"
        >
          <Plus size={18} />
          New note
        </button>
      </header>

      <NoteGrid onNoteClick={id => setEditingId(id)} />

      {isModalOpen && (
        <NoteEditorModal
          noteId={editingId ?? null}
          onClose={() => setEditingId(undefined)}
        />
      )}
    </main>
  );
}
