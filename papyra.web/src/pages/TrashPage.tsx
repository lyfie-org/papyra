import { Trash2 } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import EmptyState from '../components/EmptyState';
import { useNotes } from '../hooks/useNotes';
import { useSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import './NotesPage.css';

export default function TrashPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const { data: settings } = useSettings();

  const retention = RETENTION_OPTIONS.find(o => o.value === settings?.trashRetentionDays);
  const hint = retention
    ? retention.value < 0 ? 'Kept until you delete them' : `Auto-delete: ${retention.label.toLowerCase()}`
    : '';

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="page-title notes-page__title">Trash</h1>
        {hint && <span className="notes-page__hint">{hint}</span>}
      </header>

      {isLoading && <p className="notes-page__status">Loading…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && (
        <NoteGrid
          notes={notes ?? []}
          variant="trashed"
          empty={
            <EmptyState
              icon={Trash2}
              title="Trash is empty"
              body="Deleted notes wait here so you can change your mind. Once the time limit set in Settings runs out, they are erased for good and cannot be recovered."
              hint="Restore anything here before that time is up to keep it."
              action={{ label: 'Change how long Trash keeps notes', to: '/settings?tab=data' }}
            />
          }
        />
      )}
    </section>
  );
}
