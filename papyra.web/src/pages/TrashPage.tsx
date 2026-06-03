import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash } from '@phosphor-icons/react';
import client from '../api/client';
import type { NoteSummary } from '../types';
import './PlaceholderPage.css';
import './TrashPage.css';

const TRASH_KEY = ['notes', 'trash'] as const;

function getTrashed(): Promise<NoteSummary[]> {
  return client.get<NoteSummary[]>('/notes/trash').then(r => r.data);
}

export default function TrashPage() {
  const qc = useQueryClient();
  const { data: notes, isLoading } = useQuery({ queryKey: TRASH_KEY, queryFn: getTrashed });
  const [busy, setBusy] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: (id: string) => client.patch(`/api/notes/${id}/restore-trash`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TRASH_KEY });
      qc.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const hardDelete = useMutation({
    mutationFn: (id: string) => client.delete(`/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: TRASH_KEY }),
  });

  if (isLoading) return (
    <div className="placeholder-page">
      <Trash size={40} aria-hidden="true" />
      <p className="placeholder-page__body">Loading trash…</p>
    </div>
  );

  if (!notes || notes.length === 0) return (
    <div className="placeholder-page">
      <div className="placeholder-page__icon"><Trash size={40} /></div>
      <h2 className="placeholder-page__title">Trash is empty</h2>
      <p className="placeholder-page__body">Deleted notes will appear here before permanent removal.</p>
    </div>
  );

  return (
    <div className="trash-page">
      <header className="trash-page__header">
        <h1 className="trash-page__title">Trash</h1>
        <p className="trash-page__count">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>
      </header>

      <ul className="trash-list">
        {notes.map(note => (
          <li key={note.id} className="trash-item">
            <span className="trash-item__title">{note.title || 'Untitled'}</span>
            <div className="trash-item__actions">
              <button
                className="trash-btn"
                disabled={busy === note.id}
                onClick={() => { setBusy(note.id); restore.mutate(note.id, { onSettled: () => setBusy(null) }); }}
              >
                Restore
              </button>
              <button
                className="trash-btn trash-btn--danger"
                disabled={busy === note.id}
                onClick={() => { setBusy(note.id); hardDelete.mutate(note.id, { onSettled: () => setBusy(null) }); }}
              >
                Delete forever
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
