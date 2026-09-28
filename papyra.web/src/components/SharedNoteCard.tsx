import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { IncomingShare } from '../hooks/useShares';
import { useResolvedTheme } from '../hooks/useTheme';
import { tintInkClass } from '../lib/noteColors';
import MarkdownPreview from './MarkdownPreview';
import { dayLabel, fullStamp, useMinuteTick, useTimeZone } from '../lib/timeZone';
import './NoteCard.css';
import './SharedNoteCard.css';

/**
 * A note someone else shared with you, drawn as one of your own cards — same
 * paint (the owner's colour, muted in dark mode exactly as on their desk), same
 * preview — with one quiet line saying whose it is and what you may do.
 * Opens over the current page via `?open=<shareId>`.
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
  const access = share.access === 'edit' ? 'Can edit' : share.requestPending ? 'Edit requested' : 'View only';
  const next = new URLSearchParams(params);
  next.set('open', String(share.shareId));

  return (
    <Link
      to={{ search: next.toString() }}
      className="note-card__link"
      aria-label={`${title}, shared with you by @${share.owner}, ${access.toLowerCase()}`}
    >
      <article className={className} style={style}>
        <h3 className="note-card__title">{title}</h3>
        {share.body.trim() && <MarkdownPreview body={share.body} />}
        <p className="shared-card__foot" title={`Shared with you by @${share.owner}`}>
          <Users size={13} aria-hidden="true" />
          <span className="shared-card__owner">@{share.owner}</span>
          <span className="shared-card__access">{access}</span>
        </p>
        {shared && (
          <p className="shared-card__when">
            <time dateTime={share.sharedUtc} title={fullStamp(share.sharedUtc!, zone)}>Shared {shared}</time>
          </p>
        )}
      </article>
    </Link>
  );
}
