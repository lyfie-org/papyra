import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Users, X, Lock } from 'lucide-react';
import type { Note } from '../types/note';
import { bulkShare, plural, shareSummary } from '../lib/bulk';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './ShareDialog.css';
import './BulkShareDialog.css';

interface Suggestion { username: string; name: string }

/**
 * Share a selection with one person. Links stay per-note (one link per note
 * is rarely what anyone wants from a bulk action), so this is people only.
 * Locked notes are called out before sending — the server refuses them — and
 * the result names every note that was skipped and why.
 */
export default function BulkShareDialog({ notes, onClose }: {
  notes: Note[];
  /** `done` is true once something was shared (the selection can go). */
  onClose: (done: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef);
  const queryClient = useQueryClient();
  const listId = useId();

  const [username, setUsername] = useState('');
  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const locked = notes.filter((n) => n.secure).length;
  const shareable = notes.length - locked;

  // Who's there to share with — the same directory the @ typeahead uses.
  useEffect(() => {
    const q = username.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Suggestion[]) => setSuggestions(Array.isArray(rows) ? rows.slice(0, 8) : []))
        .catch(() => { /* aborted or offline: keep what we had */ });
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [username]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim().replace(/^@/, '');
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bulkShare(notes.map((n) => n.id), name, access);
      setSummary(shareSummary(result));
      void queryClient.invalidateQueries({ queryKey: ['shares'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = notes.length === 1 ? `“${notes[0].title.trim() || 'Untitled'}”` : plural(notes.length, 'note');

  return createPortal(
    <div
      className="share"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(summary !== null); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(summary !== null); } }}
    >
      <div ref={dialogRef} className="share__dialog bulk-share" role="dialog" aria-modal="true" aria-label={`Share ${title}`}>
        <header className="share__head">
          <h2 className="share__title">Share {title}</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={() => onClose(summary !== null)}><X size={18} /></button>
        </header>

        {summary ? (
          <div className="bulk-share__done" role="status">
            <p>{summary}</p>
            <button type="button" className="share__btn" autoFocus onClick={() => onClose(true)}>Done</button>
          </div>
        ) : (
          <form className="share__section" onSubmit={submit}>
            <h3 className="share__subhead"><Users size={15} /> With someone here</h3>
            {error && <p className="share__error" role="alert">{error}</p>}
            <div className="share__invite">
              <input
                autoFocus
                placeholder="Username"
                aria-label="Username"
                list={listId}
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <datalist id={listId}>
                {suggestions.map((s) => <option key={s.username} value={s.username}>{s.name}</option>)}
              </datalist>
              <select aria-label="Access" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
                <option value="view">Can view</option>
                <option value="edit">Can edit</option>
              </select>
              <button type="submit" className="share__btn" disabled={busy || !username.trim() || shareable === 0}>
                {busy ? 'Sharing…' : `Share ${shareable === notes.length ? '' : shareable + ' '}`.trim()}
              </button>
            </div>
            {locked > 0 && (
              <p className="bulk-share__warn">
                <Lock size={13} aria-hidden="true" />
                {shareable === 0
                  ? 'Every selected note is locked. Unlock them before sharing.'
                  : `${plural(locked, 'locked note')} will be skipped.`}
              </p>
            )}
            <p className="bulk-share__hint">
              Links are made one note at a time — open a note’s share menu for that.
            </p>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
