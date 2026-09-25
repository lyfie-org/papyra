import { Link } from 'react-router-dom';
import NoteEditor from '../components/NoteEditor';
import { useNotes } from '../hooks/useNotes';
import LoadingBar from '../components/LoadingBar';

// Mounts the editor for /note/:id. The body lives in the notes snapshot the grid
// already fetched, so we read the open note straight from that cache. Rendered by
// the workspace shell as an overlay over whichever page it was opened from.
export default function NoteEditorPage({ id }: { id: string }) {
  const { data: notes, isLoading, isError } = useNotes();

  if (isLoading) return <LoadingBar label="Loading note" />;
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
