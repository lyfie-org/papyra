import { useCallback, useEffect, useState, useRef} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import { lineDiff } from '../lib/lineDiff';
import './ConflictResolver.css';
import { useDialogFocus } from '../hooks/useDialogFocus';

// One conflict's two sides, fetched on open. Left = the parent note as Papyra has
// it; right = the sync tool's conflicting copy.
interface ConflictDetail {
  id: string;
  parentId: string;
  parentTitle: string;
  parentBody: string;
  conflictTitle: string;
  conflictBody: string;
}

type Keep = 'left' | 'right' | 'both';

interface Props {
  conflictId: string;
  onClose: () => void;
}

// Split-pane resolver for a sync conflict: shows a line diff of the parent (left)
// against the copy (right), then Keep Left / Keep Right / Keep Both. Resolution
// goes through the API (atomic) and deletes the rejected .md; the notes + conflicts
// queries are invalidated so the grid re-hydrates.
export default function ConflictResolver({ conflictId, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef);
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState<ConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/conflicts/${encodeURIComponent(conflictId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ConflictDetail;
        if (live) setDetail(data);
      } catch {
        if (live) setError('Could not load this conflict.');
      }
    })();
    return () => { live = false; };
  }, [conflictId]);

  const resolve = useCallback(async (keep: Keep) => {
    setResolving(true);
    try {
      const res = await fetch(`/api/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ['conflicts'] });
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      onClose();
    } catch {
      setError('Resolving failed.');
      setResolving(false);
    }
  }, [conflictId, queryClient, onClose]);

  const rows = detail ? lineDiff(detail.parentBody, detail.conflictBody) : null;

  return (
    <div ref={dialogRef} className="conflict-resolver" role="dialog" aria-label="Resolve conflict" aria-modal="true">
      <div className="conflict-resolver__sheet">
        <header className="conflict-resolver__head">
          <h2 className="conflict-resolver__title">Resolve Conflict</h2>
          <button type="button" className="conflict-resolver__close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {error && <p className="conflict-resolver__error" role="alert">{error}</p>}

        <div className="conflict-resolver__body">
          {detail === null && !error && <p className="conflict-resolver__muted">Loading…</p>}
          {rows !== null && (
            <>
              <p className="conflict-resolver__legend">
                <span className="conflict-resolver__swatch conflict-resolver__swatch--del" /> this note (left)
                <span className="conflict-resolver__swatch conflict-resolver__swatch--add" /> conflicting copy (right)
              </p>
              <pre className="conflict-resolver__pre">
                {rows.map((r, i) => (
                  <div key={i} className={`conflict-resolver__row conflict-resolver__row--${r.kind}`}>
                    <span className="conflict-resolver__sign">
                      {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                    </span>
                    {r.text || ' '}
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>

        <footer className="conflict-resolver__actions">
          <button
            type="button"
            className="conflict-resolver__btn"
            disabled={resolving || detail === null}
            onClick={() => void resolve('left')}
          >
            <ArrowLeft size={16} /> Keep Left
          </button>
          <button
            type="button"
            className="conflict-resolver__btn"
            disabled={resolving || detail === null}
            onClick={() => void resolve('both')}
          >
            <Copy size={16} /> Keep Both
          </button>
          <button
            type="button"
            className="conflict-resolver__btn conflict-resolver__btn--primary"
            disabled={resolving || detail === null}
            onClick={() => void resolve('right')}
          >
            Keep Right <ArrowRight size={16} />
          </button>
        </footer>
      </div>
    </div>
  );
}
