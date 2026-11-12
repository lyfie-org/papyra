import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { RowOverflow } from '../hooks/useRowOverflow';
import './RowArrows.css';

/**
 * Small arrows for a row that scrolls sideways, each on the end that has more: not everyone has a trackpad or a
 * sideways wheel. They only scroll, and stay out of the Tab order because the row's own items are already reachable by
 * keyboard. They go beside the scroller, inside the `rowScrollClass` wrapper, never in it: they must not scroll away.
 */
export default function RowArrows({ row, earlierLabel, moreLabel }: { row: RowOverflow; earlierLabel: string; moreLabel: string }) {
  return (
    <>
      {row.back && (
        <button
          type="button"
          className="row-arrow row-arrow--back"
          aria-label={earlierLabel}
          tabIndex={-1}
          onMouseDown={e => e.preventDefault()}
          onClick={() => row.page(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
      )}
      {row.forward && (
        <button
          type="button"
          className="row-arrow row-arrow--forward"
          aria-label={moreLabel}
          tabIndex={-1}
          onMouseDown={e => e.preventDefault()}
          onClick={() => row.page(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
