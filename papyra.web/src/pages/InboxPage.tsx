import { useEffect, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Inbox as InboxIcon, X } from 'lucide-react';
import { useInbox, useMarkInboxRead, INBOX_KEY } from '../hooks/useInbox';
import './InboxPage.css';

/**
 * Blocks other people have mentioned you in. Read-only by design: an entry is a
 * pointer into someone else's note, and the only thing you own here is whether
 * it stays in your list.
 */
export default function InboxPage() {
  const { data: entries, isLoading, isError } = useInbox();
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

  return (
    <section className="inbox">
      <header className="inbox__head">
        <h1 className="inbox__title">Inbox</h1>
        <p className="inbox__lede">
          Blocks other people have mentioned you in. You see only the block that
          named you — never the rest of their note.
        </p>
      </header>

      {isLoading && <p className="inbox__status">Loading…</p>}
      {isError && <p className="inbox__status">Couldn’t reach the server.</p>}

      {!isLoading && !isError && (entries ?? []).length === 0 && (
        <div className="inbox__empty">
          <InboxIcon size={20} aria-hidden="true" />
          <p>Nothing here yet. When someone writes <code>@you</code> in a note, that block lands here.</p>
        </div>
      )}

      <ul className="inbox__list">
        {(entries ?? []).map((entry) => (
          <li key={entry.id} className="inbox__entry">
            <div className="inbox__meta">
              <span className="inbox__from">@{entry.from}</span>
              <time className="inbox__time" dateTime={entry.receivedUtc}>
                {new Date(entry.receivedUtc).toLocaleString()}
              </time>
              <button
                type="button"
                className="inbox__dismiss"
                aria-label={`Dismiss mention from ${entry.from}`}
                onClick={() => dismiss.mutate(entry.id)}
              >
                <X size={14} />
              </button>
            </div>

            {entry.text
              ? <blockquote className="inbox__block">{entry.text}</blockquote>
              : <p className="inbox__gone">That block is no longer available.</p>}

            {entry.title && (
              // The link may 403 — a block grant is not access to the note. That
              // is correct, and the destination says so.
              <Link className="inbox__source" to={`/note/${encodeURIComponent(entry.noteId)}`}>
                in “{entry.title}”
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
