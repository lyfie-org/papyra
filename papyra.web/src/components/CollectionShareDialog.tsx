import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Braces, Users, X } from 'lucide-react';
import { useCollectionExport, useSendCollection } from '../hooks/useCollections';
import { useDialogFocus } from '../hooks/useDialogFocus';
import UserPicker from './UserPicker';
import BusyButton from './BusyButton';
import './ShareDialog.css';
import './CollectionShareDialog.css';

/**
 * Share a smart collection: its name and rules, never its notes — the rules run
 * against whoever's notes receive them. Send it to someone here (it waits in
 * their notifications until they add it) or copy it as JSON to paste into any
 * Papyra's Collections → Import.
 */
export default function CollectionShareDialog({ collection, onClose }: {
  collection: { id: number; name: string };
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef);
  const send = useSendCollection();
  const exported = useCollectionExport(collection.id);

  const [username, setUsername] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const name = username.trim().replace(/^@/, '');
    if (!name || send.isPending) return;
    setSentTo(null);
    try {
      const { recipient } = await send.mutateAsync({ id: collection.id, username: name });
      setSentTo(recipient);
      setUsername('');
    } catch { /* shown from send.error */ }
  }

  async function copy() {
    if (!exported.data) return;
    try {
      await navigator.clipboard.writeText(exported.data);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is selectable */ }
  }

  return createPortal(
    <div
      className="share"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div ref={dialogRef} className="share__dialog collection-share" role="dialog" aria-modal="true"
        aria-label={`Share ${collection.name}`}>
        <header className="share__head">
          <h2 className="share__title">Share “{collection.name}”</h2>
          <button type="button" className="share__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        <p className="collection-share__lede">Only the name and rules are shared. The notes stay yours.</p>

        <form className="share__section" onSubmit={submit}>
          <h3 className="share__subhead"><Users size={15} /> Send to someone here</h3>
          {send.error && <p className="share__error" role="alert">{send.error.message}</p>}
          {sentTo && <p className="share__notice" role="status">Sent to @{sentTo}. It’s in their notifications.</p>}
          <div className="share__invite">
            <UserPicker
              autoFocus
              placeholder="Add a person"
              value={username}
              onChange={setUsername}
              onSubmit={() => void submit()}
            />
            <BusyButton type="submit" className="share__btn" disabled={!username.trim()} busy={send.isPending} busyLabel="Sending…">
              Send
            </BusyButton>
          </div>
        </form>

        <section className="share__section">
          <h3 className="share__subhead"><Braces size={15} /> Copy as JSON</h3>
          {exported.error && <p className="share__error" role="alert">{exported.error.message}</p>}
          <textarea
            className="collection-share__json"
            aria-label="Collection as JSON"
            readOnly
            spellCheck={false}
            rows={8}
            value={exported.data ?? (exported.isLoading ? 'Loading…' : '')}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="collection-share__row">
            <span className="collection-share__hint">Paste it into Collections → Import in any Papyra.</span>
            <button type="button" className="share__copy" disabled={!exported.data} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
