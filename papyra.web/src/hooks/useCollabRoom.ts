import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import type { Provider } from '@lexical/yjs';
import type { CollaborationExtension } from '@lyfie/luthor-headless/collab';
import { collabColor } from '../lib/collabColors';
import { findCollabRoomCache, forgetCollabRoomCache, rememberCollabRoomCache } from '../lib/collabCache';

/**
 * Live editing of a shared note: one Yjs room per note, served by the
 * embedded collab engine behind the API's `/collab` WebSocket.
 *
 * The owner joins by note id, a grantee by share id. The API answers with a
 * short-lived signed ticket naming the room and the caller's access; a fresh
 * ticket is fetched for every (re)connect, so a revoked share can never ride an
 * old one back in.
 *
 * Offline: once a session has synced, every change is also written to
 * IndexedDB, keyed by the room's *epoch* (the Yjs lineage — see the engine's
 * rooms.ts). Updates from one lineage merged into another duplicate the note,
 * so a dropped connection is never blindly resynced. The editor keeps working
 * on its doc (offline) while a throwaway doc *probes* the room: same epoch →
 * the same doc reconnects (no remount, caret kept, offline edits merge); a new
 * epoch or a changed access → the editor is rebuilt on a fresh session.
 *
 * Offline open: with no ticket to be had (no network), a note this device has
 * edited live before opens on its IndexedDB copy — editable, marked offline —
 * and reaches the room through the same probe once the network is back. The
 * copy is checked to still hold the recorded lineage before it is shown.
 */

/**
 * The live-editing client (Yjs, Hocuspocus, y-indexeddb, luthor's collab
 * binding) is only needed once a note is actually shared, so it is a separate
 * chunk fetched the first time a room opens — never part of the main bundle.
 */
async function loadCollabLibs() {
  const [Y, hocuspocus, idb, headless] = await Promise.all([
    import('yjs'),
    import('@hocuspocus/provider'),
    import('y-indexeddb'),
    import('@lyfie/luthor-headless/collab'),
  ]);
  return {
    Y,
    HocuspocusProvider: hocuspocus.HocuspocusProvider,
    HocuspocusProviderWebsocket: hocuspocus.HocuspocusProviderWebsocket,
    IndexeddbPersistence: idb.IndexeddbPersistence,
    CollaborationExtension: headless.CollaborationExtension,
  };
}

type CollabLibs = Awaited<ReturnType<typeof loadCollabLibs>>;

let libsPromise: Promise<CollabLibs> | null = null;
let loadedLibs: CollabLibs | null = null;

function ensureCollabLibs(): Promise<CollabLibs> {
  libsPromise ??= loadCollabLibs().then(
    (libs) => { loadedLibs = libs; return libs; },
    (error) => { libsPromise = null; throw error; }, // offline first try: ask again later
  );
  return libsPromise;
}

export type CollabTarget = { noteId: string } | { shareId: number };

export type CollabStatus =
  /** Asking for a ticket, or connected but not yet synced. */
  | 'connecting'
  /** Synced with the room. */
  | 'live'
  /** Lost the room (or never reached it); retrying. Edits stay on this device. */
  | 'offline'
  /** The engine is off or degraded: use the classic autosave editor. */
  | 'unavailable'
  /** No longer shared with this person. */
  | 'revoked'
  /** Deleted, trashed or locked. */
  | 'gone';

export interface CollabTicket {
  ticket: string;
  room: string;
  access: 'edit' | 'view';
  uid: number;
  username: string;
  name: string;
  url: string;
}

/** Awareness fields every Papyra client broadcasts beside Lexical's own. */
export interface CollabAwarenessData {
  uid: number;
  username: string;
}

export interface CollabRoom {
  status: CollabStatus;
  /** Pass to `PapyraEditor`'s `collaboration`; null until a ticket is in hand. */
  collaboration: CollaborationExtension | null;
  /** Changes whenever the editor must be rebuilt (new session / access). */
  generation: number;
  access: 'edit' | 'view' | null;
  /** The current session has synced at least once: the doc holds the note. */
  synced: boolean;
  /** The live provider, for presence (awareness). */
  provider: HocuspocusProvider | null;
  self: { uid: number; username: string; name: string; color: string } | null;
}

type TicketResult =
  | { kind: 'ok'; ticket: CollabTicket }
  | { kind: 'unavailable' | 'revoked' | 'gone' | 'offline' };

export async function requestCollabTicket(target: CollabTarget): Promise<TicketResult> {
  let res: Response;
  try {
    res = await fetch('/api/collab/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.ok) return { kind: 'ok', ticket: (await res.json()) as CollabTicket };
  if (res.status === 503) {
    // The API itself says the engine is off; any other 503 is a gateway.
    const code = ((await res.json().catch(() => null)) as { code?: string } | null)?.code;
    return { kind: code === 'collab_unavailable' ? 'unavailable' : 'offline' };
  }
  if (res.status === 404 || res.status === 403) return { kind: 'revoked' };
  if (res.status === 410) return { kind: 'gone' };
  if (res.status === 401 || res.status === 429 || res.status >= 500) return { kind: 'offline' };
  return { kind: 'unavailable' };
}

/** Close reasons the engine sends (papyra.collab/src/server.ts). */
const CLOSE_ACCESS_REVOKED = 'access-revoked';
const CLOSE_NOTE_GONE = 'note-gone';
/** Engine room metadata (papyra.collab/src/rooms.ts ROOM_META / EPOCH_KEY). */
const ROOM_META = 'papyra';
const EPOCH_KEY = 'epoch';

/** A ticket this young is still good for the first connect (they live 60s). */
const TICKET_REUSE_MS = 30_000;
const REJOIN_MIN_MS = 1_000;
const REJOIN_MAX_MS = 15_000;

interface Join {
  key: string;
  ticket: CollabTicket;
  gen: number;
  /** Opened from this device's copy, without a ticket: the IndexedDB to load. */
  offline?: { db: string; epoch: string };
}

interface Session {
  gen: number;
  socket: HocuspocusProviderWebsocket;
  provider: HocuspocusProvider;
  idb: IndexeddbPersistence | null;
  synced: boolean;
  /** The room's lineage as of the first sync (see ROOM_META). */
  epoch: string | null;
  /** Disconnected on purpose or lost: status events are ignored until it reconnects. */
  retired: boolean;
  /** An offline open that hasn't reached the room yet (see Join.offline). */
  unreached: boolean;
  destroyed: boolean;
}

let nextGen = 1;

/** Per-hook mutable state: sessions by generation, the ticket in hand, retry pacing. */
class RoomStore {
  readonly sessions = new Map<number, Session>();
  private fresh: { value: string; at: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => void) | null = null;
  private backoff = REJOIN_MIN_MS;
  /**
   * A cached (offline) session is on screen and still finding the room: its
   * probe owns reconnecting, so a ticket must not rebuild the editor under it.
   */
  offlineOpen = false;

  keepTicket(value: string) { this.fresh = { value, at: Date.now() }; }

  /** The ticket fetched with the join, once, while still young. */
  takeTicket(): string | null {
    const fresh = this.fresh;
    this.fresh = null;
    return fresh && Date.now() - fresh.at < TICKET_REUSE_MS ? fresh.value : null;
  }

  /** Run `fn` after the current backoff (or `delay`), then back off further. */
  retry(fn: () => void, delay?: number) {
    clearTimeout(this.timer);
    const wait = delay ?? this.backoff;
    this.backoff = Math.min(Math.max(this.backoff * 2, REJOIN_MIN_MS), REJOIN_MAX_MS);
    this.pending = fn;
    this.timer = setTimeout(() => { this.pending = null; fn(); }, wait);
  }

  /** The network is back: run the waiting retry now. */
  retryNow() {
    const fn = this.pending;
    if (!fn) return;
    this.resetBackoff();
    this.retry(fn, 0);
  }

  resetBackoff() { this.backoff = REJOIN_MIN_MS; }
  cancel() { clearTimeout(this.timer); this.pending = null; this.offlineOpen = false; }
}

function wsUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function destroySession(session: Session) {
  if (session.destroyed) return;
  session.destroyed = true;
  session.retired = true;
  try { session.provider.destroy(); } catch { /* already torn down */ }
  try { session.socket.destroy(); } catch { /* already torn down */ }
  void session.idb?.destroy().catch(() => {});
}

/**
 * `target` null = not collaborative (nothing is fetched or opened).
 * `expectedAccess`: the access the caller believes it has (a grantee's share
 * row). When it changes — an owner approved an edit request, or downgraded the
 * share — a new ticket is fetched and the editor rebuilt with the new access.
 */
export function useCollabRoom(
  target: CollabTarget | null,
  cursorsContainerRef: RefObject<HTMLElement | null>,
  expectedAccess?: 'edit' | 'view',
): CollabRoom {
  const targetKey = target ? JSON.stringify(target) : null;
  const [join, setJoin] = useState<Join | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; status: CollabStatus; synced: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [provider, setProvider] = useState<{ gen: number; provider: HocuspocusProvider } | null>(null);
  const [libs, setLibs] = useState<CollabLibs | null>(loadedLibs);

  // Fetch the client chunk the first time a room is wanted; retry while it
  // can't be had (a cold offline open) so the editor is never stuck.
  useEffect(() => {
    if (!targetKey || libs) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      ensureCollabLibs().then(
        (loaded) => { if (!cancelled) setLibs(loaded); },
        () => { if (!cancelled) timer = setTimeout(load, REJOIN_MAX_MS); },
      );
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [targetKey, libs]);

  // Mutable bookkeeping, touched only from effects and provider callbacks.
  const [store] = useState(() => new RoomStore());

  // Ask for a ticket: on open, on every rejoin, and when the caller's access
  // changes. A failure keeps whatever session is on screen (offline editing
  // continues) and retries with backoff.
  useEffect(() => {
    if (!targetKey) return;
    let cancelled = false;
    const scheduleRetry = () => store.retry(() => setAttempt((a) => a + 1));
    void requestCollabTicket(JSON.parse(targetKey) as CollabTarget).then((result) => {
      if (cancelled) return;
      // The cached session's probe takes it from here (and checks the lineage).
      if (store.offlineOpen && (result.kind === 'ok' || result.kind === 'offline')) {
        if (result.kind === 'ok') store.retryNow();
        return;
      }
      if (result.kind === 'ok') {
        store.keepTicket(result.ticket.ticket);
        setJoin({ key: targetKey, ticket: result.ticket, gen: nextGen++ });
        setOutcome({ key: targetKey, status: 'connecting', synced: false });
        return;
      }
      if (result.kind === 'offline') {
        setOutcome((o) => ({ key: targetKey, status: 'offline', synced: o?.key === targetKey && o.synced }));
        scheduleRetry();
        return;
      }
      setJoin(null);
      setOutcome({ key: targetKey, status: result.kind, synced: false });
    });
    return () => { cancelled = true; };
  }, [targetKey, attempt, expectedAccess, store]);

  // Retry at once when the browser says the network is back.
  useEffect(() => {
    if (!targetKey) return;
    const onOnline = () => store.retryNow();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      store.cancel();
    };
  }, [targetKey, store]);

  const current = join && join.key === targetKey ? join : null;

  // No ticket (offline) and nothing on screen: open this device's copy of the
  // room, if it has one and it still holds the recorded lineage. A copy that
  // doesn't (cleared by the browser, half-written) is never shown — typing
  // into an empty doc would land beside the note when it merges.
  const offlineNow = !!targetKey && outcome?.key === targetKey && outcome.status === 'offline';
  const joined = !!current;
  useEffect(() => {
    if (!targetKey || !offlineNow || joined || !libs) return;
    const found = findCollabRoomCache(targetKey);
    if (!found) return;
    let cancelled = false;
    const { room, cache } = found;
    const doc = new libs.Y.Doc();
    const idb = new libs.IndexeddbPersistence(cache.db, doc);
    void idb.whenSynced.then(() => {
      const epoch = doc.getMap<string>(ROOM_META).get(EPOCH_KEY);
      void idb.destroy().catch(() => {});
      doc.destroy();
      if (cancelled || epoch !== cache.epoch) return;
      store.cancel();
      store.offlineOpen = true;
      setJoin({
        key: targetKey,
        ticket: {
          ticket: '', room, access: 'edit', uid: cache.uid, username: cache.username, name: cache.name, url: cache.url,
        },
        gen: nextGen++,
        offline: { db: cache.db, epoch: cache.epoch },
      });
    });
    return () => { cancelled = true; };
  }, [targetKey, offlineNow, joined, libs, store]);

  const collaboration = useMemo(() => {
    if (!current || !libs) return null;
    const { Y, HocuspocusProvider, HocuspocusProviderWebsocket, IndexeddbPersistence, CollaborationExtension } = libs;
    const { ticket, key, gen, offline } = current;
    const target = JSON.parse(key) as CollabTarget;
    const setStatus = (status: CollabStatus, synced?: boolean) =>
      setOutcome((o) => ({
        key,
        status,
        synced: synced ?? (o?.key === key ? o.synced : false),
      }));

    return new CollaborationExtension({
      id: ticket.room,
      shouldBootstrap: false,
      username: ticket.name,
      cursorColor: collabColor(ticket.username),
      awarenessData: { uid: ticket.uid, username: ticket.username } satisfies CollabAwarenessData,
      cursorsContainerRef,
      providerFactory: (id, docMap) => {
        // Lexical builds a provider per editor mount (twice under StrictMode,
        // again on a theme/colour remount): the newest one wins.
        const previous = store.sessions.get(gen);
        if (previous) destroySession(previous);

        const doc = new Y.Doc();
        docMap.set(id, doc);
        const socket = new HocuspocusProviderWebsocket({
          url: wsUrl(ticket.url),
          autoConnect: false,
          delay: REJOIN_MIN_MS,
          factor: 2,
          maxDelay: REJOIN_MAX_MS,
          maxAttempts: 0,
        });
        const session: Session = {
          gen, socket, idb: null, synced: false, epoch: offline?.epoch ?? null,
          retired: !!offline, unreached: !!offline, destroyed: false,
          provider: null as unknown as HocuspocusProvider,
        };

        // Is the room still this doc's lineage, and is our access unchanged?
        // Asked on a throwaway doc so nothing merges before we know.
        const probe = () => {
          if (session.destroyed) return;
          void requestCollabTicket(target).then((result) => {
            if (session.destroyed) return;
            if (result.kind === 'revoked' || result.kind === 'gone') {
              store.offlineOpen = false;
              setStatus(result.kind);
              return;
            }
            // Offline, or the engine is down mid-session: keep the doc (and
            // the person's edits) and keep asking. Never drop to the classic
            // editor here — it would write over what the room hasn't saved.
            if (result.kind !== 'ok') {
              store.retry(probe);
              return;
            }
            const next = result.ticket;
            if (next.access !== ticket.access) {
              store.offlineOpen = false;
              store.keepTicket(next.ticket);
              setJoin({ key, ticket: next, gen: nextGen++ });
              return;
            }
            const probeDoc = new Y.Doc();
            const probeSocket = new HocuspocusProviderWebsocket({ url: wsUrl(ticket.url), maxAttempts: 1 });
            let settled = false;
            // settle is defined below; the timer only fires after it exists.
            const timeout = setTimeout(() => settle(undefined), 15_000);
            let probeProvider: HocuspocusProvider | null = null;
            const settle = (epoch: string | null | undefined) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              probeProvider?.destroy();
              probeSocket.destroy();
              probeDoc.destroy();
              if (session.destroyed) return;
              if (epoch === undefined) {
                store.retry(probe);
              } else if (epoch !== null && epoch === session.epoch) {
                session.retired = false;
                session.unreached = false;
                setStatus('connecting');
                void socket.connect();
              } else {
                // The room was rebuilt from its file: this doc can't merge.
                console.warn('[papyra] live note was rebuilt from its file while offline; reloading it');
                store.offlineOpen = false;
                setJoin({ key, ticket: next, gen: nextGen++ });
              }
            };
            probeProvider = new HocuspocusProvider({
              websocketProvider: probeSocket,
              name: ticket.room,
              document: probeDoc,
              awareness: null,
              token: next.ticket,
              onSynced: ({ state }) => {
                if (!state) return;
                const epoch = probeDoc.getMap<string>(ROOM_META).get(EPOCH_KEY);
                settle(typeof epoch === 'string' ? epoch : null);
              },
              onAuthenticationFailed: () => settle(undefined),
              onClose: () => settle(undefined),
            });
            probeProvider.attach();
          });
        };

        // A lost session stays bound to the editor — typing keeps landing in
        // its doc and IndexedDB — while it finds its way back (see probe).
        const retire = (next: 'rejoin' | 'now' | 'gone') => {
          if (session.retired) return;
          session.retired = true;
          socket.disconnect();
          if (next === 'gone') {
            setStatus('gone');
            return;
          }
          setStatus('offline');
          if (next === 'now') probe();
          else store.retry(probe);
        };

        session.provider = new HocuspocusProvider({
          websocketProvider: socket,
          name: ticket.room,
          document: doc,
          // Every (re)connect proves access afresh.
          token: async () => {
            const fresh = store.takeTicket();
            if (fresh) return fresh;
            const result = await requestCollabTicket(target);
            if (result.kind !== 'ok') throw new Error(result.kind);
            // Access changed under us: refuse this connection; the rejoin
            // (onAuthenticationFailed) rebuilds the editor with the new access.
            if (result.ticket.access !== ticket.access) throw new Error('access-changed');
            return result.ticket.ticket;
          },
          onSynced: ({ state }) => {
            if (!state || session.retired) return;
            session.synced = true;
            store.offlineOpen = false;
            store.resetBackoff();
            setStatus('live', true);
            if (session.epoch === null) {
              const epoch = doc.getMap<string>(ROOM_META).get(EPOCH_KEY);
              session.epoch = typeof epoch === 'string' ? epoch : null;
            }
            if (ticket.access === 'view') {
              // A viewer keeps no copy — nor one from when they could edit.
              forgetCollabRoomCache(ticket.room);
            } else if (!session.idb) {
              const epoch = session.epoch;
              if (epoch !== null) {
                const name = `papyra-collab:${ticket.room}:${epoch}`;
                session.idb = new IndexeddbPersistence(name, doc);
                rememberCollabRoomCache(ticket.room, {
                  db: name, target: key, epoch,
                  uid: ticket.uid, username: ticket.username, name: ticket.name, url: ticket.url,
                });
              }
            }
          },
          onStatus: ({ status }) => {
            if (session.retired) return;
            // Before the first sync the socket retries by itself (the doc is
            // still empty, nothing can be duplicated). After it, a drop
            // retires the session and probes — see the note at the top.
            if (status === 'disconnected') {
              if (session.synced) retire('rejoin');
              else setStatus('offline');
            } else if (status === 'connecting' && !session.synced) {
              setStatus('connecting');
            }
          },
          onClose: ({ event }) => {
            if (event.reason === CLOSE_NOTE_GONE) retire('gone');
            else if (event.reason === CLOSE_ACCESS_REVOKED) {
              // Re-ask at once: a downgrade comes back as view, a revoke as 404.
              retire('now');
            }
          },
          onAuthenticationFailed: () => retire('rejoin'),
        });
        session.provider.attach();
        store.sessions.set(gen, session);
        setProvider({ gen, provider: session.provider });

        // Offline open: fill the doc from this device's copy, then look for the
        // room. Only once Lexical is bound (its first connect) — updates that
        // land before it observes the doc would never reach the editor.
        const openCopy = (db: string) => {
          if (session.idb) return;
          const idb = new IndexeddbPersistence(db, doc);
          session.idb = idb;
          void idb.whenSynced.then(() => {
            if (session.destroyed) return;
            session.synced = true;
            setStatus('offline', true);
            probe();
          });
        };

        // Lexical's Provider shape; connect/disconnect drive our own socket.
        return {
          awareness: session.provider.awareness,
          connect: () => {
            if (session.destroyed) return;
            if (offline && session.unreached) {
              openCopy(offline.db);
              return;
            }
            session.retired = false;
            void socket.connect();
          },
          // The editor unmounting: a deliberate leave, not a lost connection.
          disconnect: () => {
            session.retired = true;
            socket.disconnect();
          },
          on: (type: string, cb: (...args: unknown[]) => void) => { session.provider.on(type, cb); },
          off: (type: string, cb: (...args: unknown[]) => void) => { session.provider.off(type, cb); },
        } as unknown as Provider;
      },
    });
  }, [current, libs, cursorsContainerRef, store]);

  // A join's sessions end with it (replaced, revoked, or the note closed).
  useEffect(() => {
    if (!current) return;
    const all = store.sessions;
    const { gen } = current;
    return () => {
      const session = all.get(gen);
      if (session) {
        destroySession(session);
        all.delete(gen);
      }
    };
  }, [current, store]);

  const status: CollabStatus = targetKey && outcome?.key === targetKey ? outcome.status : 'connecting';
  // Nothing on this device should outlive the access to it.
  const lastRoom = current?.ticket.room ?? null;
  const roomRef = useRef<string | null>(null);
  useEffect(() => { if (lastRoom) roomRef.current = lastRoom; }, [lastRoom]);
  useEffect(() => {
    if ((status === 'revoked' || status === 'gone') && roomRef.current) forgetCollabRoomCache(roomRef.current);
  }, [status]);

  return {
    status,
    collaboration,
    generation: current?.gen ?? 0,
    access: current?.ticket.access ?? null,
    synced: !!(targetKey && outcome?.key === targetKey && outcome.synced),
    provider: current && provider?.gen === current.gen ? provider.provider : null,
    self: current
      ? {
        uid: current.ticket.uid,
        username: current.ticket.username,
        name: current.ticket.name,
        color: collabColor(current.ticket.username),
      }
      : null,
  };
}
