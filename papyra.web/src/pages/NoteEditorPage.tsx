import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import NoteEditor from '../components/NoteEditor';
import { useNotes } from '../hooks/useNotes';
import { retainDraft, useDraft } from '../lib/noteDrafts';
import LoadingBar from '../components/LoadingBar';

// Mounts the editor for /note/:id. The body lives in the notes snapshot the grid
// already fetched, so we read the open note straight from that cache. Rendered by
// the workspace shell as an overlay over whichever page it was opened from.
//
// A brand-new note is a local draft (lib/noteDrafts) until its first save puts
// it in the cache; the editor is the same component either way, so the switch
// from draft to saved note happens under the caret without a remount.
export default function NoteEditorPage({ id }: { id: string }) {
  const { data: notes, isLoading, isError } = useNotes();
  const draft = useDraft(id);

  // Leaving the note drops the draft: saved, the server copy has taken over;
  // untouched, there is nothing to keep.
  useEffect(() => retainDraft(id), [id]);

  const saved = notes?.find((n) => n.id === id);
  const note = saved ?? draft;
  if (!note) {
    if (isLoading) return <LoadingBar label="Loading note" />;
    if (isError) return <p className="notes-page__status">Couldn’t reach the server.</p>;
    return (
      <p className="notes-page__status">
        Note not found. <Link to="/">Back to notes</Link>
      </p>
    );
  }

  return <NoteEditor note={note} isDraft={!saved} />;
}
