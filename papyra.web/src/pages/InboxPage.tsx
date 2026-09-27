import { useEffect, useRef, useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { originState } from '../lib/noteLink';
import { Inbox as InboxIcon, X, Lock } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
import { useInbox, useMarkInboxRead, INBOX_KEY, type InboxEntry } from '../hooks/useInbox';
import {
  useAccessRequests, useAnswerAccessRequest, useRequestAccess, type AccessRequest,
} from '../hooks/useShares';
import { useToast } from '../lib/toastContext';
import './InboxPage.css';
import LoadingBar from '../components/LoadingBar';

/**
 * Two kinds of thing land here: people asking for access to your notes (which
 * need a decision), and mentions of you in other people's notes.
 *
 * Access is the whole note or nothing. A mention in a note shared with you
 * shows the paragraph and opens the note; one in a note you can't open says
 * who and when, and lets you ask for access — like Google Docs.
 */
export default function InboxPage() {
  const { data: entries, isLoading, isError } = useInbox();
  const { data: requests } = useAccessRequests();
  const queryClient = useQueryClient();
  const markRead = useMarkInboxRead();

  // Clear the sidebar badge once the list is actually on screen. Fired once per
  // visit (the ref guards React's double-invoked effects in StrictMode and any
  // refetch), and only when something is genuinely unread — otherwise every
  // visit would POST for nothing.
  const marked = useRef(false);
  const hasUnread = (entries ?? []).some((e) => !e.readUtc);
  useEffect(() => {
    if (marked.current || !hasUnread) return;
    marked.current = true;
    markRead.mutate();
  }, [hasUnread, markRead]);

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/inbox/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE /api/inbox/${id} failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  });

  const pendingRequests = requests ?? [];
  const nothing = !isLoading && !isError && (entries ?? []).length === 0 && pendingRequests.length === 0;

  return (
    <section className="inbox">
      <header className="inbox__head">
        <h1 className="page-title inbox__title">Inbox</h1>
        <p className="inbox__lede">
          Requests for access to your notes, and places other people have
          mentioned you.
        </p>
      </header>

      {isLoading && <LoadingBar label="Loading inbox" />}
      {isError && <p className="inbox__status">Couldn’t reach the server.</p>}

      {nothing && (
        <EmptyState
          icon={InboxIcon}
          title="Nothing here yet"
          body="When someone else on this server types your name after an @ in one of their notes, it shows up here — and so does anyone asking for access to one of yours."
          hint="Mentioning someone asks whether to share the note with them. If it isn't shared, they can ask you for access from here."
        />
      )}

      {pendingRequests.length > 0 && (
        <section className="inbox__section" aria-labelledby="inbox-requests">
          <h2 className="inbox__section-title" id="inbox-requests">Access requests</h2>
          <ul className="inbox__list">
            {pendingRequests.map((r) => <RequestRow key={r.id} request={r} />)}
          </ul>
        </section>
      )}

      {(entries ?? []).length > 0 && (
        <section className="inbox__section" aria-labelledby="inbox-mentions">
          {pendingRequests.length > 0 && <h2 className="inbox__section-title" id="inbox-mentions">Mentions</h2>}
          <ul className="inbox__list">
            {(entries ?? []).map((entry) => (
              <MentionRow key={entry.id} entry={entry} onDismiss={() => dismiss.mutate(entry.id)} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function RequestRow({ request }: { request: AccessRequest }) {
  const answer = useAnswerAccessRequest();
  const { toast } = useToast();
  const [access, setAccess] = useState<'view' | 'edit'>(request.access);
  const title = request.title.trim() || 'Untitled';
  const upgrading = request.currentAccess === 'view';
  const location = useLocation();

  async function decide(approve: boolean) {
    try {
      await answer.mutateAsync({ id: request.id, approve, access });
      toast(approve
        ? `@${request.requester} can now ${access === 'edit' ? 'edit' : 'view'} “${title}”.`
        : `Declined @${request.requester}’s request.`);
    } catch (e) { toast((e as Error).message); }
  }

  return (
    <li className="inbox__entry inbox__entry--request">
      <div className="inbox__meta">
        <span className="inbox__from">
          <Avatar username={request.requester} name={request.requesterName ?? request.requester} size={22} />
          @{request.requester}
        </span>
        <time className="inbox__time" dateTime={request.createdUtc}>
          {new Date(request.createdUtc).toLocaleString()}
        </time>
      </div>
      <p className="inbox__ask">
        {upgrading ? 'Can view and is asking to ' : 'Is asking to '}
        <strong>{request.access === 'edit' ? 'edit' : 'view'}</strong>{' '}
        <Link className="inbox__note-link" to={`/note/${encodeURIComponent(request.noteId)}`} state={originState(location)}>“{title}”</Link>
      </p>
      <div className="inbox__decide">
        <label className="inbox__role">
          <select aria-label="Access to give" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')} disabled={answer.isPending}>
            <option value="edit">Can edit</option>
            <option value="view" disabled={upgrading}>Can view</option>
          </select>
        </label>
        <button type="button" className="inbox__btn" disabled={answer.isPending} onClick={() => void decide(false)}>
          Decline
        </button>
        <button type="button" className="inbox__btn inbox__btn--go" disabled={answer.isPending} onClick={() => void decide(true)}>
          {upgrading && access === 'view' ? 'Keep view only' : 'Approve'}
        </button>
      </div>
    </li>
  );
}

function MentionRow({ entry, onDismiss }: { entry: InboxEntry; onDismiss: () => void }) {
  const request = useRequestAccess();
  const { toast } = useToast();

  async function ask() {
    try {
      await request.mutateAsync({ inboxId: entry.id, access: 'edit' });
      toast(`Asked @${entry.from} for access.`);
    } catch (e) { toast((e as Error).message); }
  }

  return (
    <li className="inbox__entry">
      <div className="inbox__meta">
        <span className="inbox__from">
          <Avatar username={entry.from} name={entry.from} size={22} />
          @{entry.from}
        </span>
        <span className="inbox__verb">mentioned you</span>
        <time className="inbox__time" dateTime={entry.receivedUtc}>
          {new Date(entry.receivedUtc).toLocaleString()}
        </time>
        <button
          type="button"
          className="inbox__dismiss"
          aria-label={`Dismiss mention from ${entry.from}`}
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>

      {!entry.available ? (
        <p className="inbox__gone">That note is no longer available.</p>
      ) : entry.shareId != null ? (
        <>
          {entry.text && <blockquote className="inbox__block">{entry.text}</blockquote>}
          <div className="inbox__row">
            <Link className="inbox__open" to={`/shared-with-me?open=${entry.shareId}`}>
              Open “{entry.title?.trim() || 'Untitled'}”
            </Link>
            <span className="inbox__access">{entry.access === 'edit' ? 'You can edit' : 'View only'}</span>
          </div>
        </>
      ) : (
        <div className="inbox__locked">
          <Lock size={14} aria-hidden="true" />
          <span className="inbox__locked-text">
            {entry.requestPending
              ? `You asked @${entry.from} for access. You’ll see the note here once they approve.`
              : `This note isn’t shared with you. Ask @${entry.from} for access to read it and reply.`}
          </span>
          <button
            type="button"
            className="inbox__btn inbox__btn--go"
            disabled={entry.requestPending || request.isPending}
            onClick={() => void ask()}
          >
            {entry.requestPending ? 'Requested' : 'Request access'}
          </button>
        </div>
      )}
    </li>
  );
}
