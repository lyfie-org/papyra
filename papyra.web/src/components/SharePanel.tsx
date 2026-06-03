import { useRef, useState, type FormEvent } from 'react';
import { UserPlus, Link, Trash, X, Copy, Check } from '@phosphor-icons/react';
import {
  useShares,
  useCreateShare,
  useRemoveShare,
  useCreatePublicLink,
  useRevokePublicLink,
} from '../hooks/useShares';
import type { PublicLinkResponse, ShareRecord } from '../types';
import './SharePanel.css';

interface SharePanelProps {
  noteId: string;
  onClose: () => void;
}

export default function SharePanel({ noteId, onClose }: SharePanelProps) {
  const { data: shares = [], isLoading } = useShares(noteId);
  const createShare     = useCreateShare(noteId);
  const removeShare     = useRemoveShare(noteId);
  const createPublicLink = useCreatePublicLink(noteId);
  const revokePublicLink = useRevokePublicLink(noteId);

  const userShares   = shares.filter(s => s.grantee);
  const publicLinks  = shares.filter(s => !s.grantee && s.publicToken);

  const [grantee,    setGrantee]    = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [addErr,     setAddErr]     = useState('');

  const [expiresInDays, setExpiresInDays] = useState(30);
  const [newLink,       setNewLink]       = useState<PublicLinkResponse | null>(null);
  const [linkCopied,    setLinkCopied]    = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);

  function handleAddUser(e: FormEvent) {
    e.preventDefault();
    const g = grantee.trim().toLowerCase();
    if (!g) { setAddErr('Username is required.'); return; }
    setAddErr('');
    createShare.mutate({ grantee: g, permission }, {
      onSuccess: () => setGrantee(''),
      onError:   () => setAddErr('Failed to add share. Check the username.'),
    });
  }

  function handleCreateLink(e: FormEvent) {
    e.preventDefault();
    createPublicLink.mutate({ expiresInDays }, {
      onSuccess: link => { setNewLink(link); setLinkCopied(false); },
    });
  }

  function copyLink(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  function publicLinkUrl(token: string) {
    return `${window.location.origin}/share/${token}`;
  }

  function formatExpiry(iso: string) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(iso));
  }

  return (
    <div className="share-panel" role="dialog" aria-modal="true" aria-label="Share note">
      <div className="share-panel__inner">
        <header className="share-panel__header">
          <h3 className="share-panel__title">Share</h3>
          <button className="share-panel__close btn btn--icon" onClick={onClose} aria-label="Close share panel">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {isLoading ? (
          <p className="share-panel__empty">Loading…</p>
        ) : (
          <>
            {/* ── User shares ──────────────────────────────────────────── */}
            <section className="share-panel__section">
              <p className="share-panel__section-title">
                <UserPlus size={14} aria-hidden="true" />
                Share with a user
              </p>
              <form className="share-panel__add-form" onSubmit={handleAddUser} noValidate>
                <input
                  className="share-panel__input"
                  type="text"
                  placeholder="Username"
                  value={grantee}
                  onChange={e => setGrantee(e.target.value)}
                  aria-label="Grantee username"
                  autoComplete="off"
                  spellCheck={false}
                />
                <select
                  className="share-panel__select"
                  value={permission}
                  onChange={e => setPermission(e.target.value as 'read' | 'write')}
                  aria-label="Permission level"
                >
                  <option value="read">Can view</option>
                  <option value="write">Can edit</option>
                </select>
                <button
                  type="submit"
                  className="share-panel__add-btn"
                  disabled={createShare.isPending}
                  aria-label="Add share"
                >
                  Add
                </button>
              </form>
              {addErr && <p className="share-panel__err" role="alert">{addErr}</p>}

              {userShares.length > 0 && (
                <ul className="share-panel__list">
                  {userShares.map(s => (
                    <ShareRow
                      key={s.shareId}
                      share={s}
                      onRemove={() => removeShare.mutate(s.shareId)}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* ── Public links ─────────────────────────────────────────── */}
            <section className="share-panel__section">
              <p className="share-panel__section-title">
                <Link size={14} aria-hidden="true" />
                Public link
              </p>
              <form className="share-panel__link-form" onSubmit={handleCreateLink} noValidate>
                <label className="share-panel__link-label" htmlFor="share-expiry">
                  Expires in
                </label>
                <select
                  id="share-expiry"
                  className="share-panel__select"
                  value={expiresInDays}
                  onChange={e => setExpiresInDays(Number(e.target.value))}
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={365}>1 year</option>
                </select>
                <button
                  type="submit"
                  className="share-panel__add-btn"
                  disabled={createPublicLink.isPending}
                >
                  {createPublicLink.isPending ? 'Creating…' : 'Create link'}
                </button>
              </form>

              {newLink && (
                <div className="share-panel__new-link">
                  <input
                    ref={linkInputRef}
                    className="share-panel__link-input"
                    readOnly
                    value={publicLinkUrl(newLink.token)}
                    onClick={() => linkInputRef.current?.select()}
                    aria-label="Public link URL"
                  />
                  <button
                    className="share-panel__copy-btn"
                    onClick={() => copyLink(publicLinkUrl(newLink.token))}
                    aria-label="Copy link"
                  >
                    {linkCopied
                      ? <><Check size={13} aria-hidden="true" /> Copied</>
                      : <><Copy size={13} aria-hidden="true" /> Copy</>}
                  </button>
                </div>
              )}

              {publicLinks.length > 0 && (
                <ul className="share-panel__list">
                  {publicLinks.map(s => (
                    <PublicLinkRow
                      key={s.shareId}
                      share={s}
                      onCopy={() => copyLink(publicLinkUrl(s.publicToken!))}
                      onRevoke={() => revokePublicLink.mutate(s.shareId)}
                      formatExpiry={formatExpiry}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ShareRow({ share, onRemove }: { share: ShareRecord; onRemove: () => void }) {
  return (
    <li className="share-panel__row">
      <span className="share-panel__row-name">{share.grantee}</span>
      <span className={`share-panel__badge share-panel__badge--${share.permission}`}>
        {share.permission === 'write' ? 'Can edit' : 'Can view'}
      </span>
      <button
        className="share-panel__remove-btn btn btn--icon"
        onClick={onRemove}
        aria-label={`Remove share for ${share.grantee}`}
      >
        <Trash size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

function PublicLinkRow({
  share,
  onCopy,
  onRevoke,
  formatExpiry,
}: {
  share: ShareRecord;
  onCopy: () => void;
  onRevoke: () => void;
  formatExpiry: (iso: string) => string;
}) {
  return (
    <li className="share-panel__row share-panel__row--link">
      <span className="share-panel__row-name">
        Public link
        {share.expiresAt && (
          <span className="share-panel__expiry"> · expires {formatExpiry(share.expiresAt)}</span>
        )}
      </span>
      <button className="share-panel__copy-btn share-panel__copy-btn--sm" onClick={onCopy} aria-label="Copy link">
        <Copy size={12} aria-hidden="true" />
      </button>
      <button className="share-panel__remove-btn btn btn--icon" onClick={onRevoke} aria-label="Revoke link">
        <Trash size={13} aria-hidden="true" />
      </button>
    </li>
  );
}
