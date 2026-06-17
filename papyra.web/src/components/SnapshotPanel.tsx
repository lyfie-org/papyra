import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, RotateCcw } from 'lucide-react';
import type { Note } from '../types/note';
import { lineDiff } from '../lib/lineDiff';
import './SnapshotPanel.css';

interface SnapshotMeta {
  id: string;
  timestamp: string;
}

// File Recovery overlay: lists a note's archived revisions, shows a line diff of
// the selected snapshot against the current body, and restores it on demand.
// Restore goes through the API (atomic .md replace); the notes query is
// invalidated so the editor re-baselines on the restored revision.
interface Props {
  noteId: string;
  currentBody: string;
  onClose: () => void;
  onRestored: () => void;
}

export default function SnapshotPanel({ noteId, currentBody, onClose, onRestored }: Props) {
  const queryClient = useQueryClient();
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedBody, setSelectedBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Load the revision list when the panel opens.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as SnapshotMeta[];
        if (live) setSnapshots(list);
      } catch {
        if (live) setError('Could not load version history.');
      }
    })();
    return () => { live = false; };
  }, [noteId]);

  // Fetch one snapshot's body to diff against the live note.
  const select = useCallback(async (snapshotId: string) => {
    setSelected(snapshotId);
    setSelectedBody(null);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots/${encodeURIComponent(snapshotId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const note = (await res.json()) as Note;
      setSelectedBody(note.body);
    } catch {
      setError('Could not load that revision.');
    }
  }, [noteId]);

  const restore = useCallback(async (snapshotId: string) => {
    setRestoring(true);
    try {
      const res = await fetch(
        `/api/notes/${encodeURIComponent(noteId)}/restore/${encodeURIComponent(snapshotId)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      onRestored();
      onClose();
    } catch {
      setError('Restore failed.');
      setRestoring(false);
    }
  }, [noteId, queryClient, onRestored, onClose]);

  const rows = selectedBody !== null ? lineDiff(selectedBody, currentBody) : null;

  return (
    <div className="snapshot-panel" role="dialog" aria-label="File recovery" aria-modal="true">
      <div className="snapshot-panel__sheet">
        <header className="snapshot-panel__head">
          <h2 className="snapshot-panel__title">File Recovery</h2>
          <button type="button" className="snapshot-panel__close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {error && <p className="snapshot-panel__error" role="alert">{error}</p>}

        <div className="snapshot-panel__body">
          <ul className="snapshot-panel__list">
            {snapshots === null && !error && <li className="snapshot-panel__muted">Loading…</li>}
            {snapshots?.length === 0 && <li className="snapshot-panel__muted">No earlier versions yet.</li>}
            {snapshots?.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`snapshot-panel__entry${selected === s.id ? ' is-active' : ''}`}
                  onClick={() => void select(s.id)}
                >
                  {new Date(s.timestamp).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>

          <div className="snapshot-panel__diff">
            {selected === null && <p className="snapshot-panel__muted">Pick a version to see what changed.</p>}
            {selected !== null && rows === null && <p className="snapshot-panel__muted">Loading diff…</p>}
            {rows !== null && (
              <>
                <p className="snapshot-panel__legend">
                  <span className="snapshot-panel__swatch snapshot-panel__swatch--del" /> this version
                  <span className="snapshot-panel__swatch snapshot-panel__swatch--add" /> current
                </p>
                <pre className="snapshot-panel__pre">
                  {rows.map((r, i) => (
                    <div key={i} className={`snapshot-panel__row snapshot-panel__row--${r.kind}`}>
                      <span className="snapshot-panel__sign">
                        {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                      </span>
                      {r.text || ' '}
                    </div>
                  ))}
                </pre>
                <div className="snapshot-panel__actions">
                  <button
                    type="button"
                    className="snapshot-panel__restore"
                    disabled={restoring}
                    onClick={() => { if (selected) void restore(selected); }}
                  >
                    <RotateCcw size={16} /> {restoring ? 'Restoring…' : 'Restore this version'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
