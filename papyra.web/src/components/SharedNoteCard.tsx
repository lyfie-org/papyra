import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pin } from 'lucide-react';
import { useSharedPin, type IncomingShare } from '../hooks/useShares';
import { useResolvedTheme } from '../hooks/useTheme';
import { tintInkClass } from '../lib/noteColors';
import MarkdownPreview from './MarkdownPreview';
import Avatar from './Avatar';
import SharedNoteActions from './SharedNoteActions';
import { dayLabel, fullStamp, useMinuteTick, useTimeZone } from '../lib/timeZone';
import './NoteCard.css';
import './SharedNoteCard.css';

/**
 * A note someone else shared with you, drawn as one of your own cards — same
 * paint (the owner's colour, muted in dark mode exactly as on their desk), same
 * preview, same actions on hover — with the owner's face at its foot, and
 * "Can view" when you can only read it. Opens over the current page via
 * `?open=<shareId>`.
 */
export default function SharedNoteCard({ share, showSharedDate = false }: {
  share: IncomingShare;
  /** Add "Shared 12 Sep" under the owner (the Shared with me page). */
  showSharedDate?: boolean;
}) {
  const theme = useResolvedTheme();
  const zone = useTimeZone();
  const now = useMinuteTick();
  const shared = showSharedDate && share.sharedUtc ? dayLabel(share.sharedUtc, zone, now) : null;
  const [params] = useSearchParams();
  const style = share.color ? ({ '--note-tint': share.color } as CSSProperties) : undefined;
  const className = `note-card shared-card${share.color ? ` note-card--colored${tintInkClass(share.color, theme)}` : ''}`;
  const title = share.title.trim() || 'Untitled';
  // Editing is the default for a note shared with you; only the exceptions are spelled out.
  const access = share.access === 'edit' ? null : share.requestPending ? 'Edit requested' : 'Can view';
  const owner = share.ownerName && share.ownerName !== share.owner ? `${share.ownerName} (@${share.owner})` : `@${share.owner}`;
  const via = share.sharedBy ? `, via @${share.sharedBy}` : '';
  const next = new URLSearchParams(params);
  next.set('open', String(share.shareId));
  const pin = useSharedPin();
  const pinned = !!share.pinned;
  const tags = share.tags ?? [];

  return (
    <Link
      to={{ search: next.toString() }}
      className="note-card__link"
      aria-label={`${title}, shared with you by ${owner}${via}${access ? `, ${access.toLowerCase()}` : ', can edit'}`}
    >
      <article className={className} style={style}>
        {/* Your own pin for it — the owner's desk is unaffected. */}
        <button
          type="button"
          className={`note-card__pin${pinned ? ' note-card__pin--active' : ''}`}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin note' : 'Pin note'}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); pin.mutate({ shareId: share.shareId, pinned: !pinned }); }}
        >
          <Pin size={15} fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <h3 className="note-card__title">{title}</h3>
        {share.body.trim() && <MarkdownPreview body={share.body} />}
        {tags.length > 0 && (
          <ul className="note-card__tags" aria-label="Your tags">
            {tags.map((tag) => <li key={tag} className="note-card__tag">{tag}</li>)}
          </ul>
        )}
        <p className="shared-card__foot" title={`Shared with you by ${owner}${via}`}>
          <Avatar username={share.owner} name={share.ownerName} size={22} className="shared-card__face" />
          {access && <span className="shared-card__access">{access}</span>}
        </p>
        {shared && (
          <p className="shared-card__when">
            <time dateTime={share.sharedUtc} title={fullStamp(share.sharedUtc!, zone)}>Shared {shared}</time>
          </p>
        )}
        <div className="note-card__actions">
          <SharedNoteActions share={share} variant="card" />
        </div>
      </article>
    </Link>
  );
}
