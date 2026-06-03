import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive } from '@phosphor-icons/react';
import client from '../api/client';
import type { NoteSummary } from '../types';
import './PlaceholderPage.css';
import './ArchivePage.css';

const ARCHIVED_KEY = ['notes', 'archived'] as const;

function getArchived(): Promise<NoteSummary[]> {
  return client.get<NoteSummary[]>('/notes/archived').then(r => r.data);
}

export default function ArchivePage() {
  const qc = useQueryClient();
  const { data: notes, isLoading } = useQuery({ queryKey: ARCHIVED_KEY, queryFn: getArchived });
  const [busy, setBusy] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: (id: string) => client.patch(`/api/notes/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
      qc.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const trash = useMutation({
    mutationFn: (id: string) => client.patch(`/api/notes/${id}/trash`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ARCHIVED_KEY }),
  });

  if (isLoading) return (
    <div className="placeholder-page">
      <Archive size={40} aria-hidden="true" />
      <p className="placeholder-page__body">Loading archive…</p>
    </div>
  );

  if (!notes || notes.length === 0) return (
    <div className="placeholder-page">
      <div className="placeholder-page__icon"><Archive size={40} /></div>
      <h2 className="placeholder-page__title">Archive is empty</h2>
      <p className="placeholder-page__body">Notes you archive will appear here.</p>
    </div>
  );

  return (
    <div className="archive-page">
      <header className="archive-page__header">
        <h1 className="archive-page__title">Archive</h1>
        <p className="archive-page__count">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>
      </header>

      <ul className="archive-list">
        {notes.map(note => (
          <li key={note.id} className="archive-item">
            <span className="archive-item__title">{note.title || 'Untitled'}</span>
            <div className="archive-item__actions">
              <button
                className="archive-btn"
                disabled={busy === note.id}
                onClick={() => { setBusy(note.id); restore.mutate(note.id, { onSettled: () => setBusy(null) }); }}
              >
                Restore
              </button>
              <button
                className="archive-btn archive-btn--danger"
                disabled={busy === note.id}
                onClick={() => { setBusy(note.id); trash.mutate(note.id, { onSettled: () => setBusy(null) }); }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
