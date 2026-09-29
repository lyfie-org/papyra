import { useState, type ReactNode } from 'react';
import { Check, MoreHorizontal, RotateCcw, SmilePlus } from 'lucide-react';
import Avatar from '../Avatar';
import CommentComposer from './CommentComposer';
import { relativeTime } from '../../lib/history';
import { useConfirm } from '../../lib/confirmContext';
import { useToast } from '../../lib/toastContext';
import type { CommentThread, CommentsData, NoteCommentItem, useComments } from '../../hooks/useComments';

type Api = ReturnType<typeof useComments>;

/** "@bea" in a comment, set apart; everything else is plain text (never HTML). */
function Body({ text, people }: { text: string; people: Set<string> }) {
  const parts: ReactNode[] = [];
  const re = /(^|[^\w@])@([A-Za-z0-9_.-]{1,64})/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[1].length;
    if (!people.has(m[2].toLowerCase())) continue;
    parts.push(text.slice(last, at));
    parts.push(<span key={at} className="comment__mention">@{m[2]}</span>);
    last = at + m[2].length + 1;
  }
  parts.push(text.slice(last));
  return <p className="comment__body">{parts}</p>;
}

function Item({ c, data, api, onFirstDeleted }: {
  c: NoteCommentItem; data: CommentsData; api: Api; onFirstDeleted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const confirm = useConfirm();
  const { toast } = useToast();
  const handles = new Set(data.people.map(p => p.username.toLowerCase()));

  async function remove() {
    setMenu(false);
    const ok = await confirm({
      title: onFirstDeleted ? 'Delete this thread?' : 'Delete this comment?',
      body: onFirstDeleted ? 'The comment and every reply to it are deleted for everyone.' : 'It’s deleted for everyone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try { await api.remove.mutateAsync(c.id); onFirstDeleted?.(); } catch (e) { toast((e as Error).message); }
  }

  return (
    <li className="comment">
      <Avatar username={c.author.username} name={c.author.name} size={26} className="comment__avatar" />
      <div className="comment__main">
        <div className="comment__head">
          <span className="comment__name" title={`@${c.author.username}`}>{c.author.name}</span>
          <time className="comment__time" dateTime={c.createdUtc} title={new Date(c.createdUtc).toLocaleString()}>
            {relativeTime(new Date(c.createdUtc))}{c.editedUtc ? ' · edited' : ''}
          </time>
          {(c.canEdit || c.canDelete) && (
            <div className="comment__menu">
              <button type="button" className="comment-icon" aria-label="Comment actions" aria-expanded={menu}
                onClick={() => setMenu(m => !m)}>
                <MoreHorizontal size={15} />
              </button>
              {menu && (
                <div className="comment__menu-list" role="menu" onMouseLeave={() => setMenu(false)}>
                  {c.canEdit && <button type="button" role="menuitem" onClick={() => { setMenu(false); setEditing(true); }}>Edit</button>}
                  {c.canDelete && <button type="button" role="menuitem" className="is-danger" onClick={() => void remove()}>Delete</button>}
                </div>
              )}
            </div>
          )}
        </div>
        {editing ? (
          <CommentComposer
            people={data.people}
            placeholder="Edit comment"
            initial={c.body}
            submitLabel="Save"
            autoFocus
            busy={api.edit.isPending}
            onSubmit={async (body) => { await api.edit.mutateAsync({ id: c.id, body }); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : <Body text={c.body} people={handles} />}

        <div className="comment__reactions">
          {c.reactions.map(r => (
            <button key={r.emoji} type="button" className={`comment__reaction${r.mine ? ' is-mine' : ''}`}
              aria-pressed={r.mine} title={r.people.map(p => `@${p}`).join(', ')}
              onClick={() => api.react.mutate({ id: c.id, emoji: r.emoji })}>
              <span aria-hidden="true">{r.emoji}</span> {r.count}
            </button>
          ))}
          <div className="comment__react">
            <button type="button" className="comment-icon comment__react-btn" aria-label="Add reaction" aria-expanded={picker}
              onClick={() => setPicker(p => !p)}>
              <SmilePlus size={15} />
            </button>
            {picker && (
              <div className="comment__picker" role="menu" onMouseLeave={() => setPicker(false)}>
                {data.reactions.map(emoji => (
                  <button key={emoji} type="button" role="menuitem" aria-label={`React ${emoji}`}
                    onClick={() => { setPicker(false); api.react.mutate({ id: c.id, emoji }); }}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * One thread: the passage it's about, its comments, a reply box, and
 * resolve/reopen. Used in the hover card, the focus-mode rail and the panel.
 */
export default function CommentThreadView({ thread, data, api, showQuote, detached, autoFocusReply, onClosed }: {
  thread: CommentThread;
  data: CommentsData;
  api: Api;
  showQuote?: boolean;
  /** Its passage can't be found in the note any more. */
  detached?: boolean;
  autoFocusReply?: boolean;
  /** The thread went away (resolved or deleted) from here. */
  onClosed?: () => void;
}) {
  const { toast } = useToast();
  return (
    <div className={`comment-thread${thread.resolved ? ' is-resolved' : ''}`}>
      {(showQuote || detached) && thread.quote && (
        <blockquote className={`comment-thread__quote${detached ? ' is-detached' : ''}`}>
          {detached && <span className="comment-thread__detached">Original text changed · </span>}
          {thread.quote.exact}
        </blockquote>
      )}
      {thread.resolved && thread.resolvedBy && (
        <p className="comment-thread__resolved">
          <Check size={13} aria-hidden="true" /> Resolved by {thread.resolvedBy.name}
        </p>
      )}
      <ul className="comment-thread__list">
        {thread.comments.map((c, i) => (
          <Item key={c.id} c={c} data={data} api={api} onFirstDeleted={i === 0 ? onClosed : undefined} />
        ))}
      </ul>
      <div className="comment-thread__foot">
        <CommentComposer
          people={data.people}
          placeholder={thread.resolved ? 'Reply to reopen' : 'Reply'}
          submitLabel="Reply"
          compact
          autoFocus={autoFocusReply}
          busy={api.create.isPending}
          onSubmit={(body) => api.create.mutateAsync({ body, threadId: thread.id })}
        />
        {thread.canResolve && (
          <button type="button" className="comment-btn comment-thread__resolve"
            onClick={async () => {
              try {
                await api.resolve.mutateAsync({ id: thread.id, resolved: !thread.resolved });
                if (!thread.resolved) onClosed?.();
              } catch (e) { toast((e as Error).message); }
            }}>
            {thread.resolved ? <><RotateCcw size={14} aria-hidden="true" /> Reopen</> : <><Check size={14} aria-hidden="true" /> Resolve</>}
          </button>
        )}
      </div>
    </div>
  );
}
