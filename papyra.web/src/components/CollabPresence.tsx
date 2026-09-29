import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { CloudOff, Loader2 } from 'lucide-react';
import Avatar from './Avatar';
import type { CollabAwarenessData, CollabStatus } from '../hooks/useCollabRoom';
import { LABEL_IDLE_MS } from '../hooks/useCollabCursorLabels';
import './CollabPresence.css';

/** Someone who hasn't moved their caret for this long reads as "idle". */
const EDITING_WINDOW_MS = 30_000;

interface Peer {
  clientId: number;
  uid: number | null;
  username: string | null;
  name: string;
  color: string;
  lastActive: number;
  /** Serialized caret position, to notice movement. */
  pos: string;
}

/** Lexical's awareness state (plus our awarenessData). */
interface AwarenessState {
  name?: string;
  color?: string;
  anchorPos?: unknown;
  focusPos?: unknown;
  awarenessData?: Partial<CollabAwarenessData>;
}

/** Scroll a collaborator's caret into view and show their label. */
function revealCursor(container: HTMLElement | null, name: string) {
  if (!container) return;
  const label = [...container.querySelectorAll<HTMLElement>(':scope > div > span > span > span')]
    .find((el) => el.textContent === name);
  const selection = label?.parentElement?.parentElement;
  if (!label || !selection) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  label.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  selection.setAttribute('data-collab-active', '');
  setTimeout(() => selection.removeAttribute('data-collab-active'), LABEL_IDLE_MS);
}

function readPeers(provider: HocuspocusProvider, previous: Map<number, Peer>): Map<number, Peer> {
  const awareness = provider.awareness;
  const next = new Map<number, Peer>();
  if (!awareness) return next;
  const now = Date.now();
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const state = raw as AwarenessState;
    if (!state.name) return;
    const before = previous.get(clientId);
    const pos = JSON.stringify([state.anchorPos ?? null, state.focusPos ?? null]);
    next.set(clientId, {
      clientId,
      uid: state.awarenessData?.uid ?? null,
      username: state.awarenessData?.username ?? null,
      name: state.name,
      color: state.color ?? 'var(--text)',
      lastActive: !before || before.pos !== pos ? now : before.lastActive,
      pos,
    });
  });
  return next;
}

const STATUS_TEXT: Partial<Record<CollabStatus, string>> = {
  connecting: 'Joining…',
  offline: 'Offline — edits are kept on this device',
  revoked: 'Your access to this note was removed',
  gone: 'This note is no longer available',
};

/**
 * Who else is in the note: an avatar per person (one per account, however many
 * tabs), ringed in their caret colour, "editing" or "idle" on hover. Click to
 * jump to their caret. Also carries the room's connection state.
 */
export default function CollabPresence({
  provider, status, cursorsRef, selfUid, viewOnly = false,
}: {
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  cursorsRef: RefObject<HTMLElement | null>;
  selfUid: number | null;
  viewOnly?: boolean;
}) {
  const [peers, setPeers] = useState<Map<number, Peer>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!provider || !awareness) return;
    const update = () => setPeers((prev) => readPeers(provider, prev));
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [provider]);

  // "editing" → "idle" needs a clock, not just awareness events.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  // One face per person; their most recently active tab speaks for them.
  const people = new Map<string, Peer>();
  const shown = provider ? peers : new Map<number, Peer>();
  shown.forEach((peer) => {
    if (peer.uid !== null && peer.uid === selfUid) return; // my other tabs
    const key = peer.uid !== null ? `u${peer.uid}` : `c${peer.clientId}`;
    const existing = people.get(key);
    if (!existing || peer.lastActive > existing.lastActive) people.set(key, peer);
  });
  const list = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const note = STATUS_TEXT[status];

  return (
    <div className="collab-presence">
      {note && (
        <span className={`collab-presence__status collab-presence__status--${status}`} role="status">
          {status === 'connecting' && <Loader2 size={13} className="collab-presence__spin" aria-hidden="true" />}
          {status === 'offline' && <CloudOff size={13} aria-hidden="true" />}
          {viewOnly && status === 'offline' ? 'Offline — reconnecting' : note}
        </span>
      )}
      {status === 'live' && list.length > 0 && (
        <ul className="collab-presence__people" aria-label="People in this note">
          {list.map((peer) => {
            const editing = now - peer.lastActive < EDITING_WINDOW_MS;
            const label = `${peer.name} — ${editing ? 'editing' : 'idle'}`;
            return (
              <li key={peer.clientId}>
                <button
                  type="button"
                  className={`collab-presence__person${editing ? '' : ' collab-presence__person--idle'}`}
                  style={{ '--collab-ring': peer.color } as CSSProperties}
                  title={label}
                  aria-label={`${label}. Show their cursor`}
                  onClick={() => revealCursor(cursorsRef.current, peer.name)}
                >
                  <Avatar username={peer.username ?? undefined} name={peer.name} size={26} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
