import { Link } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import { useIncomingShares } from '../hooks/useShares';
import './SharedRail.css';

/**
 * Notes other people have shared with you, as a column beside the desk.
 *
 * These used to live on their own `/shared-with-me` page, which meant a share
 * you had been granted was invisible unless you went looking for it. They are
 * not your notes — they live in someone else's vault and are reached through a
 * share grant — so they stay a distinct section rather than being mixed into
 * the grid, where they would inherit drag ordering and pinning they cannot
 * actually have.
 *
 * Renders nothing at all when no one has shared anything, so a single-user
 * vault never sees an empty column.
 */
export default function SharedRail() {
  const { data: incoming, isLoading } = useIncomingShares();

  if (isLoading || (incoming?.length ?? 0) === 0) return null;

  return (
    <aside className="shared-rail" aria-label="Shared with me">
      <h2 className="shared-rail__title">
        <Share2 size={14} aria-hidden="true" /> Shared with me
      </h2>
      <ul className="shared-rail__list">
        {incoming!.map((s) => (
          <li key={s.shareId}>
            <Link className="shared-rail__item" to={`/shared-with-me?open=${s.shareId}`}>
              <span className="shared-rail__item-title">{s.title.trim() || 'Untitled'}</span>
              <span className="shared-rail__item-meta">
                @{s.owner}
                {s.access === 'edit' && <span className="shared-rail__badge">can edit</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
