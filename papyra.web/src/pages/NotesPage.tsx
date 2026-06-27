import { useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import DraggableNoteGrid from '../components/DraggableNoteGrid';
import ConflictResolver from '../components/ConflictResolver';
import { useNotes } from '../hooks/useNotes';
import { useConflicts, type Conflict } from '../hooks/useConflicts';
import './NotesPage.css';

export default function NotesPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const { data: conflicts } = useConflicts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<string | null>(null);

  // Group conflicts under the note they shadow so each card can flag its own.
  const conflictsByParent = useMemo(() => {
    const map = new Map<string, Conflict[]>();
    for (const c of conflicts ?? []) {
      const list = map.get(c.parentId);
      if (list) list.push(c);
      else map.set(c.parentId, [c]);
    }
    return map;
  }, [conflicts]);

  // Create = PUT a fresh, empty note (the API upserts) then open it. The id is
  // minted client-side; the .md becomes the source of truth on first write.
  async function createNote() {
    const id = crypto.randomUUID();
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', tags: [], color: null, pinned: false, archived: false, body: '' }),
    });
    if (!res.ok) throw new Error(`PUT /api/notes/${id} failed: ${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    navigate(`/note/${id}`);
  }

  return (
    <section className="notes-page">
      <header className="notes-page__head">
        <button type="button" className="notes-page__new" onClick={() => void createNote()}>
          <Plus size={18} />
          New note
        </button>
      </header>

      {isLoading && <p className="notes-page__status">Loading notes…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && (
        <DraggableNoteGrid
          notes={notes ?? []}
          conflictsByParent={conflictsByParent}
          onResolveConflict={setResolving}
        />
      )}

      {resolving && (
        <ConflictResolver conflictId={resolving} onClose={() => setResolving(null)} />
      )}

      {/* /note/:id renders the editor modal over this grid. */}
      <Outlet />
    </section>
  );
}
