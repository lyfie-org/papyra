import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import logo from '../assets/papyra_logo.png';
import SharedNoteView, { type SharedNote } from '../components/SharedNoteView';
import './SharedNotePage.css';

// Public landing for a tokenised share link. No session required — the token is
// the authorisation. Expired/limit-reached links return a friendly message.
export default function SharedNotePage() {
  const { token } = useParams<{ token: string }>();
  const [note, setNote] = useState<SharedNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Fetch counts a view server-side, so guard against React StrictMode's
  // double-invoke (dev) firing it twice — one visit must be exactly one view.
  const fetchedToken = useRef<string | null>(null);

  useEffect(() => {
    if (fetchedToken.current === token) return;
    fetchedToken.current = token ?? null;
    (async () => {
      const res = await fetch(`/api/shared/${token}`);
      if (res.ok) { setNote(await res.json()); }
      else {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? (res.status === 404 ? 'This shared note was not found.' : 'Couldn’t load this note.'));
      }
      setLoading(false);
    })();
  }, [token]);

  async function save(body: string) {
    const res = await fetch(`/api/shared/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
  }

  return (
    <div className="shared-page">
      <header className="shared-page__brand">
        <img className="shared-page__logo" src={logo} alt="" aria-hidden="true" />
        <span className="shared-page__wordmark">Papyra</span>
      </header>
      <main className="shared-page__main">
        {loading && <p className="shared-page__status">Loading…</p>}
        {error && <p className="shared-page__status">{error}</p>}
        {note && (
          <SharedNoteView
            note={note}
            onSave={save}
            mediaUrl={(f) => `/api/shared/${token}/media/${encodeURIComponent(f)}`}
          />
        )}
      </main>
    </div>
  );
}
