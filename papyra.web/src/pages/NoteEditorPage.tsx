import { Link, useParams } from 'react-router-dom';
import NoteEditor from '../components/NoteEditor';
import { useNotes } from '../hooks/useNotes';

// Mounts the editor for /note/:id. The body lives in the notes snapshot the grid
// already fetched, so we read the open note straight from that cache.
export default function NoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { data: notes, isLoading, isError } = useNotes();

  if (isLoading) return <p className="notes-page__status">Loading note…</p>;
  if (isError) return <p className="notes-page__status">Couldn’t reach the server.</p>;

  const note = notes?.find((n) => n.id === id);
  if (!note) {
    return (
      <p className="notes-page__status">
        Note not found. <Link to="/">Back to notes</Link>
      </p>
    );
  }

  return <NoteEditor note={note} />;
}
