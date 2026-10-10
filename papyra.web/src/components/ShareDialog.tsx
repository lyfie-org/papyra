import { useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, Users, X, Trash2, Plus, Link as LinkIcon } from 'lucide-react';
import type { Note } from '../types/note';
import { useNoteShares, useCreateShare, useRevokeShare, type Share } from '../hooks/useShares';
import { useNotes } from '../hooks/useNotes';
import { useAuth } from '../hooks/useAuth';
import { linkedNotes } from '../lib/linkedNotes';
import { plural } from '../lib/bulk';
import './ShareDialog.css';
import { useDialogFocus } from '../hooks/useDialogFocus';
import UserPicker from './UserPicker';
import Avatar from './Avatar';

// Link limits as a short list of sensible choices rather than a calendar and a
// number spinner: nobody needs "expires 14 March" precision for a share link,
// and the spinner's tiny arrows were fiddly.
const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '1', label: 'In 1 day' },
  { value: '7', label: 'In 7 days' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
];
const VIEW_OPTIONS = [
  { value: '', label: 'Unlimited' },
  { value: '1', label: 'Once' },
  { value: '5', label: '5 views' },
  { value: '10', label: '10 views' },
  { value: '25', label: '25 views' },
  { value: '100', label: '100 views' },
];

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
  const [expires, setExpires] = useState('');           // days from now; '' = never
  const [maxViews, setMaxViews] = useState('');
  const [username, setUsername] = useState('');
  const [userAccess, setUserAccess] = useState<'view' | 'edit'>('view');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { user: me } = useAuth();

  // The notes this one links to. Sharing a note whose [[links]] lead nowhere
  // for the other person is half a share: offer them too — all, or a choice.
  const { data: allNotes } = useNotes();
  const linked = useMemo(() => linkedNotes(note, allNotes ?? []), [note, allNotes]);
  const [withLinked, setWithLinked] = useState(true);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const chosen = linked.filter((n) => !skipped.has(n.id));
  const toggleLinked = (id: string) => setSkipped((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const links = (shares ?? []).filter(s => s.kind === 'link');
  const people = (shares ?? []).filter(s => s.kind === 'user');
  // Already shared with: not offered again in the picker.
  const sharedWith = new Set(people.map(s => (s.grantee ?? '').toLowerCase()));

  async function createLink() {
    setError(null);
    try {
      await create.mutateAsync({
        kind: 'link', access,
        expiresUtc: expires ? new Date(Date.now() + Number(expires) * 86_400_000).toISOString() : null,
        maxViews: maxViews ? Number(maxViews) : null,
      });
      setExpires(''); setMaxViews('');
    } catch (e) { setError((e as Error).message); }
  }

  async function addPerson() {
    setError(null);
    setNotice(null);
    const name = username.trim().replace(/^@/, '');
    if (!name) return;
    try {
      await create.mutateAsync({ kind: 'user', access: userAccess, granteeUsername: name });
      setUsername('');
    } catch (e) { setError((e as Error).message); return; }
    if (!withLinked || chosen.length === 0) return;
    // The linked notes go with the same access, in one request.
    try {
      const res = await fetch('/api/shares/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteIds: chosen.map((n) => n.id), granteeUsername: name, access: userAccess }),
      });
      const data = await res.json().catch(() => null) as { shared?: number; results?: { status: string }[]; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Couldn’t share the linked notes (${res.status}).`);
      const already = data?.results?.filter((r) => r.status === 'alreadyShared').length ?? 0;
      setNotice(`Also shared ${plural(data?.shared ?? 0, 'linked note')} with @${name}`
        + (already ? ` (${plural(already, 'was', 'were')} already shared).` : '.'));
      void queryClient.invalidateQueries({ queryKey: ['shares'] });
    } catch (e) { setError((e as Error).message); }
  }

  async function copy(s: Share) {
    if (!s.token) return;
    try { await navigator.clipboard.writeText(shareUrl(s.token)); setCopied(s.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  }

  // Portalled to <body>. Opened from a card, this used to render inside the
  // grid cell, and the cell is positioned with a CSS transform — which makes it
  // the containing block for anything `position: fixed` inside it. The
  // "full-screen" overlay was clipped to one column. Pointer events are stopped
  // at the root because React still bubbles them up the component tree, where
  // the card's drag handle would read a click in the dialog as a drag.
  return createPortal(
    <div
      className="share"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={dialogRef} className="share__dialog" role="dialog" aria-modal="true" aria-label="Share note">
        <header className="share__head">
          <h2 className="share__title">Share “{note.title.trim() || 'Untitled'}”</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        {error && <p className="share__error" role="alert">{error}</p>}
        {notice && <p className="share__notice" role="status">{notice}</p>}

        {/* People (internal user-to-user) */}
        <section className="share__section">
          <h3 className="share__subhead"><Users size={15} /> People</h3>
          <div className="share__invite">
            <UserPicker
              value={username}
              onChange={setUsername}
              onSubmit={() => void addPerson()}
              exclude={sharedWith}
            />
            <select aria-label="Access" value={userAccess} onChange={(e) => setUserAccess(e.target.value as 'view' | 'edit')}>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
            <button type="button" className="share__btn" onClick={() => void addPerson()}><Plus size={15} /> Add</button>
          </div>
          {linked.length > 0 && (
            <fieldset className="share__linked">
              <legend className="share__linked-head">
                <label className="share__check">
                  <input type="checkbox" checked={withLinked && chosen.length > 0}
                    ref={(el) => { if (el) el.indeterminate = withLinked && chosen.length > 0 && chosen.length < linked.length; }}
                    onChange={(e) => { setWithLinked(e.target.checked); if (e.target.checked) setSkipped(new Set()); }} />
                  <LinkIcon size={14} aria-hidden="true" />
                  Also share the {plural(linked.length, 'note')} it links to
                </label>
              </legend>
              {withLinked && (
                <ul className="share__linked-list">
                  {linked.map((n) => (
                    <li key={n.id}>
                      <label className="share__check">
                        <input type="checkbox" checked={!skipped.has(n.id)} onChange={() => toggleLinked(n.id)} />
                        {n.title.trim() || 'Untitled'}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}
          <ul className="share__people">
            <li className="share__person">
              <Avatar username={me?.username} name={me?.name} size={28} />
              <span className="share__person-name">You (owner)</span>
              <span className="share__access">Owner</span>
            </li>
            {people.map(s => (
              <li className="share__person" key={s.id}>
                <Avatar username={s.grantee ?? undefined} size={28} />
                <span className="share__person-name">
                  {s.grantee}
                  {s.sharedBy && <span className="share__by"> · added by @{s.sharedBy}</span>}
                </span>
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
            <select aria-label="Link access" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
            <label className="share__opt">Expires
              <select value={expires} onChange={(e) => setExpires(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="share__opt">Max views
              <select value={maxViews} onChange={(e) => setMaxViews(e.target.value)}>
                {VIEW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
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
    </div>,
    document.body,
  );
}
