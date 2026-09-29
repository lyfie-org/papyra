import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Inbox, X, Lock } from 'lucide-react';
import Avatar from './Avatar';
import {
  useNotifications, useNotificationBadge, useMarkNotificationsRead, useDismissNotification,
  type AppNotification,
} from '../hooks/useNotifications';
import { useAnswerAccessRequest, useRequestAccess } from '../hooks/useShares';
import { useToast } from '../lib/toastContext';
import './NotificationBell.css';

/** "just now", "5m", "3h", "2d", then a date. */
function ago(iso: string): string {
  // Server timestamps are UTC; some arrive without a zone marker.
  const t = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

const quoted = (n: AppNotification) => `“${n.title?.trim() || 'Untitled'}”`;

/**
 * The notification tray: a small inbox button in the top bar and the panel it
 * opens. Mentions, shares, edit-access upgrades, access requests on your notes
 * (approve or decline right here) and answers to your own requests.
 *
 * Entries are marked read when the panel closes, so what was new stays marked
 * while you look at it. `?notifications=1` (old /inbox links, emails) opens it.
 */
export default function NotificationBell() {
  const { data: items, isLoading } = useNotifications();
  const badge = useNotificationBadge();
  const markRead = useMarkNotificationsRead();
  const [opened, setOpened] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [params, setParams] = useSearchParams();
  // Deep link (old /inbox links, emails): the tray is open while the parameter
  // is in the URL, and closing drops it so a reload doesn't reopen.
  const deepLinked = params.has('notifications');
  const open = opened || deepLinked;

  const hasUnread = (items ?? []).some(n => !n.readUtc);
  const close = useCallback((refocus = false) => {
    setOpened(false);
    if (deepLinked) {
      const next = new URLSearchParams(params);
      next.delete('notifications');
      setParams(next, { replace: true });
    }
    if (hasUnread) markRead.mutate();
    if (refocus) buttonRef.current?.focus();
  }, [deepLinked, hasUnread, markRead, params, setParams]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    // Capture + stop: Escape closes the tray and nothing beneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  const list = items ?? [];
  // Decisions waiting on me first; everything else newest first.
  const waiting = list.filter(n => n.kind === 'access_requested' && n.requestStatus === 'pending');
  const rest = list.filter(n => !waiting.includes(n));

  return (
    <div className="notif" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="workspace__theme-toggle notif__button"
        aria-label={badge > 0 ? `Notifications, ${badge} new` : 'Notifications'}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpened(true))}
      >
        <Inbox size={18} />
        {badge > 0 && <span className="notif__badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
      </button>

      {open && (
        <div className="notif__panel" role="dialog" aria-label="Notifications">
          <header className="notif__head">
            <h2 className="notif__title">Notifications</h2>
          </header>
          {isLoading ? (
            <p className="notif__loading" role="status">Loading…</p>
          ) : list.length === 0 ? (
            <div className="notif__empty">
              <Inbox size={22} aria-hidden="true" />
              <p>You’re all caught up.</p>
              <p className="notif__empty-hint">
                Mentions, notes shared with you and requests for access to yours show up here.
              </p>
            </div>
          ) : (
            <ul className="notif__list">
              {[...waiting, ...rest].map(n => <Item key={n.id} n={n} onNavigate={() => close()} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ n, onNavigate }: { n: AppNotification; onNavigate: () => void }) {
  const navigate = useNavigate();
  const dismiss = useDismissNotification();
  const answer = useAnswerAccessRequest();
  const { toast } = useToast();
  const [role, setRole] = useState<'view' | 'edit'>(n.access ?? 'edit');

  const who = <strong className="notif__who">@{n.actor}</strong>;
  const noteName = n.title != null ? <span className="notif__note">{quoted(n)}</span> : 'a note';
  const isComment = n.kind === 'comment' || n.kind === 'comment_reply' || n.kind === 'comment_mention';
  const canOpen = n.available && (n.shareId != null || (isComment && n.mine));

  function open() {
    onNavigate();
    // A comment opens the note with its thread in view.
    const thread = isComment && n.threadId ? `comment=${n.threadId}` : '';
    if (n.mine) navigate(`/note/${encodeURIComponent(n.noteId)}${thread ? `?${thread}` : ''}`);
    else if (n.shareId != null) navigate(`/?open=${n.shareId}${thread ? `&${thread}` : ''}`);
  }

  async function decide(approve: boolean) {
    if (n.requestId == null) return;
    try {
      await answer.mutateAsync({ id: n.requestId, approve, access: role });
      toast(approve
        ? `@${n.actor} can now ${role === 'edit' ? 'edit' : 'view'} ${quoted(n)}.`
        : `Declined @${n.actor}’s request.`);
    } catch (e) { toast((e as Error).message); }
  }

  let line: React.ReactNode;
  switch (n.kind) {
    case 'mention': line = <>{who} mentioned you in {noteName}</>; break;
    case 'shared': line = <>{who} shared {noteName} with you · {n.access === 'edit' ? 'can edit' : 'can view'}</>; break;
    case 'access_upgraded': line = <>{who} gave you edit access to {noteName}</>; break;
    case 'access_approved': line = <>{who} approved your request · you {n.access === 'edit' ? 'can edit' : 'can view'} {noteName}</>; break;
    case 'access_denied': line = <>{who} declined your request for {noteName}</>; break;
    case 'access_requested': line = <>{who} is asking to {n.access === 'edit' ? 'edit' : 'view'} {noteName}</>; break;
    case 'comment': line = <>{who} commented on {noteName}</>; break;
    case 'comment_reply': line = <>{who} replied to a comment on {noteName}</>; break;
    case 'comment_mention': line = <>{who} mentioned you in a comment on {noteName}</>; break;
  }

  return (
    <li className={`notif__item${n.readUtc ? '' : ' notif__item--unread'}`}>
      <Avatar username={n.actor} name={n.actorName ?? n.actor} size={30} className="notif__avatar" />
      <div className="notif__body">
        <p className="notif__line">{line}</p>
        <time className="notif__time" dateTime={n.createdUtc}>{ago(n.createdUtc)}</time>

        {(n.kind === 'mention' || isComment) && n.text && <blockquote className="notif__quote">{n.text}</blockquote>}

        {!n.available && <p className="notif__muted">That note is no longer available.</p>}

        {n.available && n.kind === 'access_requested' && (
          n.requestStatus === 'pending' ? (
            <div className="notif__actions">
              <select
                className="notif__select"
                aria-label="Access to give"
                value={role}
                onChange={e => setRole(e.target.value as 'view' | 'edit')}
                disabled={answer.isPending}
              >
                <option value="edit">Can edit</option>
                <option value="view">Can view</option>
              </select>
              <button type="button" className="notif__btn" disabled={answer.isPending} onClick={() => void decide(false)}>
                Decline
              </button>
              <button type="button" className="notif__btn notif__btn--go" disabled={answer.isPending} onClick={() => void decide(true)}>
                Approve
              </button>
            </div>
          ) : (
            <p className="notif__muted">{n.requestStatus === 'approved' ? 'Approved' : 'Declined'}</p>
          )
        )}

        {n.available && n.kind !== 'access_requested' && (
          canOpen ? (
            <div className="notif__actions">
              <button type="button" className="notif__link" onClick={open}>
                {isComment ? 'Open comment' : <>Open {n.shareAccess === 'edit' ? '· you can edit' : '· view only'}</>}
              </button>
            </div>
          ) : n.kind === 'mention' ? (
            <MentionAccess n={n} />
          ) : null
        )}
      </div>
      <button
        type="button"
        className="notif__dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismiss.mutate(n.id)}
      >
        <X size={14} />
      </button>
    </li>
  );
}

/** A mention in a note you can't open: ask its author for access. */
function MentionAccess({ n }: { n: AppNotification }) {
  const request = useRequestAccess();
  const { toast } = useToast();
  return (
    <div className="notif__locked">
      <Lock size={13} aria-hidden="true" />
      <span>{n.requestPending ? 'Access requested' : 'Not shared with you'}</span>
      <button
        type="button"
        className="notif__btn notif__btn--go"
        disabled={n.requestPending || request.isPending}
        onClick={async () => {
          try {
            await request.mutateAsync({ notificationId: n.id, access: 'edit' });
            toast(`Asked @${n.actor} for access.`);
          } catch (e) { toast((e as Error).message); }
        }}
      >
        {n.requestPending ? 'Requested' : 'Request access'}
      </button>
    </div>
  );
}
