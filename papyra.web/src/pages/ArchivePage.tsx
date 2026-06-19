import NoteGrid from '../components/NoteGrid';
import { useNotes } from '../hooks/useNotes';
import './NotesPage.css';

export default function ArchivePage() {
  const { data: notes, isLoading, isError } = useNotes();

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="notes-page__title">Archive</h1>
      </header>

      {isLoading && <p className="notes-page__status">Loading…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && (
        <NoteGrid notes={notes ?? []} variant="archived" emptyLabel="Nothing archived." />
      )}
    </section>
  );
}
