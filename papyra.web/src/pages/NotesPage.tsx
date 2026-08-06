import { useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, UploadCloud } from 'lucide-react';
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
  const [dragging, setDragging] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // Quick-import: drop .md/.txt onto the grid → new notes (native DnD, no lib).
  async function importFiles(fileList: FileList) {
    const files = [...fileList].filter((f) => /\.(md|txt)$/i.test(f.name));
    if (files.length === 0) { setImportMsg('Only .md and .txt files can be imported.'); return; }
    setImportMsg('Importing…');
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    const res = await fetch('/api/import/quick', { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      setImportMsg(`Imported ${data?.imported?.length ?? 0} note${data?.imported?.length === 1 ? '' : 's'}.`);
    } else {
      setImportMsg('Import failed.');
    }
  }

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
    <section
      className="notes-page"
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      <header className="notes-page__head">
        <button type="button" className="notes-page__new" onClick={() => void createNote()}>
          <Plus size={18} />
          New note
        </button>
        {importMsg && <span className="notes-page__import-msg">{importMsg}</span>}
      </header>

      {dragging && (
        <div className="notes-page__dropzone" aria-hidden="true">
          <UploadCloud size={40} />
          <p>Drop <code>.md</code> or <code>.txt</code> files to import</p>
        </div>
      )}

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
