import { Link2, Users } from 'lucide-react';
import Avatar from './Avatar';
import './ShareBadge.css';

export interface ShareSummary {
  noteId: string;
  people: string[];
  links: number;
}

/**
 * Says that a note has left the vault, and to whom.
 *
 * Papyra's whole pitch is that your notes are yours, which makes "who else can
 * read this one" worth showing on the card rather than two clicks away in a
 * dialog. The count is the glance; the names are on hover and on focus, because
 * a mouse is not the only way to ask.
 */
export default function ShareBadge({ summary }: { summary: ShareSummary }) {
  const { people, links } = summary;
  if (people.length === 0 && links === 0) return null;

  const parts: string[] = [];
  if (people.length > 0) parts.push(`${people.length} ${people.length === 1 ? 'person' : 'people'}`);
  if (links > 0) parts.push(`${links} ${links === 1 ? 'link' : 'links'}`);

  return (
    <span
      className="share-badge"
      tabIndex={0}
      // One sentence covering what the popover shows, so a screen reader gets
      // the detail without having to reach a hover state it cannot produce.
      aria-label={`Shared with ${parts.join(' and ')}${people.length > 0 ? `: ${people.join(', ')}` : ''}`}
      // The badge sits inside the card's link; a click on it is a click on
      // nothing, not a trip into the note.
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      {people.length > 0 ? <Users size={12} aria-hidden="true" /> : <Link2 size={12} aria-hidden="true" />}
      <span className="share-badge__count">{parts.join(' · ')}</span>

      <span className="share-badge__detail" role="presentation">
        {people.length > 0 && (
          <>
            <span className="share-badge__detail-head">Shared with</span>
            {people.map(name => <span key={name} className="share-badge__person">@{name}</span>)}
          </>
        )}
        {links > 0 && (
          <span className="share-badge__links">
            {links === 1 ? 'One link share is live' : `${links} link shares are live`} — anyone holding
            {links === 1 ? ' it' : ' one'} can read this note.
          </span>
        )}
      </span>
    </span>
  );
}

/** "Shared by @owner", for a note someone else owns. */
export function SharedByBadge({ owner, access }: { owner: string; access: 'view' | 'edit' }) {
  return (
    <span className="share-badge share-badge--incoming">
      <Avatar username={owner} name={owner} size={16} />
      <span className="share-badge__count">
        Shared by @{owner} · {access === 'edit' ? 'you can edit' : 'read only'}
      </span>
    </span>
  );
}
