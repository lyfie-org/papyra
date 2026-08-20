import { useState, useRef} from 'react';
import { Link2, Users, X, Trash2, Plus } from 'lucide-react';
import type { Note } from '../types/note';
import { useNoteShares, useCreateShare, useRevokeShare, type Share } from '../hooks/useShares';
import './ShareDialog.css';
import { useDialogFocus } from '../hooks/useDialogFocus';

function shareUrl(token: string) {
  return `${window.location.origin}/shared/${token}`;
}

export default function ShareDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef);
  const { data: shares } = useNoteShares(note.id);
  const create = useCreateShare(note.id);
  const revoke = useRevokeShare(note.id);

  const [access, setAccess] = useState<'view' | 'edit'>('view');
  const [expires, setExpires] = useState('');           // yyyy-mm-dd
  const [maxViews, setMaxViews] = useState('');
  const [username, setUsername] = useState('');
  const [userAccess, setUserAccess] = useState<'view' | 'edit'>('view');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const links = (shares ?? []).filter(s => s.kind === 'link');
  const people = (shares ?? []).filter(s => s.kind === 'user');

  async function createLink() {
    setError(null);
    try {
      await create.mutateAsync({
        kind: 'link', access,
        expiresUtc: expires ? new Date(expires).toISOString() : null,
        maxViews: maxViews ? Number(maxViews) : null,
      });
      setExpires(''); setMaxViews('');
    } catch (e) { setError((e as Error).message); }
  }

  async function addPerson() {
    setError(null);
    const name = username.trim();
    if (!name) return;
    try {
      await create.mutateAsync({ kind: 'user', access: userAccess, granteeUsername: name });
      setUsername('');
    } catch (e) { setError((e as Error).message); }
  }

  async function copy(s: Share) {
    if (!s.token) return;
    try { await navigator.clipboard.writeText(shareUrl(s.token)); setCopied(s.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  }

  return (
    <div className="share" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="share__dialog" role="dialog" aria-modal="true" aria-label="Share note">
        <header className="share__head">
          <h2 className="share__title">Share “{note.title.trim() || 'Untitled'}”</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        {error && <p className="share__error" role="alert">{error}</p>}

        {/* People (internal user-to-user) */}
        <section className="share__section">
          <h3 className="share__subhead"><Users size={15} /> People</h3>
          <div className="share__invite">
            <input
              placeholder="Add by username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addPerson(); } }}
            />
            <select value={userAccess} onChange={(e) => setUserAccess(e.target.value as 'view' | 'edit')}>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
            <button type="button" className="share__btn" onClick={() => void addPerson()}><Plus size={15} /> Add</button>
          </div>
          <ul className="share__people">
            <li className="share__person">
              <span className="share__avatar" aria-hidden="true">O</span>
              <span className="share__person-name">You (owner)</span>
              <span className="share__access">Owner</span>
            </li>
            {people.map(s => (
              <li className="share__person" key={s.id}>
                <span className="share__avatar" aria-hidden="true">{(s.grantee ?? '?').charAt(0).toUpperCase()}</span>
                <span className="share__person-name">{s.grantee}</span>
                <span className="share__access">{s.access === 'edit' ? 'Can edit' : 'Can view'}</span>
                <button type="button" className="share__revoke" aria-label="Revoke" onClick={() => void revoke.mutate(s.id)}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Public tokenised links */}
        <section className="share__section">
          <h3 className="share__subhead"><Link2 size={15} /> Anyone with the link</h3>
          <div className="share__link-form">
            <select value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
            <label className="share__opt">Expires
              <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
            <label className="share__opt">Max views
              <input type="number" min={1} placeholder="∞" value={maxViews} onChange={(e) => setMaxViews(e.target.value)} />
            </label>
            <button type="button" className="share__btn" onClick={() => void createLink()}>
              <Plus size={15} /> Create link
            </button>
          </div>
          <ul className="share__links">
            {links.map(s => (
              <li className="share__link-row" key={s.id}>
                <input readOnly value={s.token ? shareUrl(s.token) : ''} onFocus={(e) => e.currentTarget.select()} />
                <span className="share__meta">
                  {s.access === 'edit' ? 'edit' : 'view'}
                  {s.maxViews ? ` · ${s.viewCount}/${s.maxViews}` : ''}
                  {s.expiresUtc ? ` · until ${new Date(s.expiresUtc).toLocaleDateString()}` : ''}
                </span>
                <button type="button" className="share__copy" onClick={() => void copy(s)}>
                  {copied === s.id ? 'Copied' : 'Copy'}
                </button>
                <button type="button" className="share__revoke" aria-label="Revoke" onClick={() => void revoke.mutate(s.id)}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {links.length === 0 && <li className="share__empty">No links yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
