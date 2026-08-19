import { useEffect, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { originState } from '../lib/noteLink';
import { Inbox as InboxIcon, X } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import { useInbox, useMarkInboxRead, INBOX_KEY } from '../hooks/useInbox';
import './InboxPage.css';

/**
 * Blocks other people have mentioned you in. Read-only by design: an entry is a
 * pointer into someone else's note, and the only thing you own here is whether
 * it stays in your list.
 *
 * An entry is still just the paragraph. What changed is that the author is now
 * asked, as they write, whether to share the whole note as well — so an entry
 * may or may not come with access to the note behind it, and the copy here must
 * not promise either way.
 */
export default function InboxPage() {
  const location = useLocation();
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
        <h1 className="page-title inbox__title">Inbox</h1>
        <p className="inbox__lede">
          Paragraphs other people have named you in. Each entry is the paragraph
          itself; whether you can open the note it came from is up to whoever
          wrote it.
        </p>
      </header>

      {isLoading && <p className="inbox__status">Loading…</p>}
      {isError && <p className="inbox__status">Couldn’t reach the server.</p>}

      {!isLoading && !isError && (entries ?? []).length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="Nothing here yet"
          body="When someone else on this server types your name after an @ in one of their notes, the paragraph they wrote it in shows up here."
          hint="They're asked at the same time whether to share the whole note with you. If they say no, the paragraph is all you get — and the same choice is yours when you mention someone."
        />
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
              <Link className="inbox__source" to={`/note/${encodeURIComponent(entry.noteId)}`} state={originState(location)}>
                in “{entry.title}”
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
