import NoteGrid from '../components/NoteGrid';
import { useNotes } from '../hooks/useNotes';

export default function NotesPage() {
  const { data: notes, isLoading, isError } = useNotes();

  if (isLoading) return <p className="notes-page__status">Loading notes…</p>;
  if (isError) return <p className="notes-page__status">Couldn’t reach the server.</p>;

  return (
    <section>
      <NoteGrid notes={notes ?? []} />
    </section>
  );
}
