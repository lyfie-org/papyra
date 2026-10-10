import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ErrorScreen from '../components/ErrorScreen';
import LoadingBar from '../components/LoadingBar';

/**
 * `/n/<owner>/<noteId>` — a copied link to a note. One link works for its
 * owner (their note opens) and for everyone it is shared with (their share of
 * it opens); anyone else is told it isn't shared with them, and learns nothing
 * more.
 */
export default function OpenNoteLinkPage() {
  const { owner = '', noteId = '' } = useParams();
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/shares/open?owner=${encodeURIComponent(owner)}&noteId=${encodeURIComponent(noteId)}`)
        .catch(() => null);
      if (cancelled) return;
      if (!res?.ok) { setMissing(true); return; }
      const where = await res.json() as { mine: boolean; noteId?: string; shareId?: number };
      navigate(where.mine ? `/note/${encodeURIComponent(noteId)}` : `/?open=${where.shareId}`, { replace: true });
    })();
    return () => { cancelled = true; };
  }, [owner, noteId, navigate]);

  if (!missing) return <LoadingBar label="Opening the note" />;
  return (
    <ErrorScreen
      code="Not shared with you"
      info={{
        title: 'This note isn’t shared with you',
        message: `Ask @${owner} to share it with you, then open the link again.`,
      }}
      actions={[{ label: 'Back to notes', onClick: () => navigate('/'), primary: true }]}
    />
  );
}
