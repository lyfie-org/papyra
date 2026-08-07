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

// File Recovery overlay: lists a note's archived revisions, shows a GitHub-style
// line diff of the selected snapshot against the live body, and restores it.
// Restore goes through the API (which snapshots the current revision first), so a
// restore is itself reversible — the pre-restore version reappears in the list to
// "undo" with. The panel stays open after a restore so that undo is one click away.
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
  // The body the diff treats as "current". Updated after a restore so the next
  // diff (for undo) compares against what's actually on disk now.
  const [liveBody, setLiveBody] = useState(currentBody);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnapshots((await res.json()) as SnapshotMeta[]);
    } catch {
      setError('Could not load version history.');
    }
  }, [noteId]);

  useEffect(() => { void loadSnapshots(); }, [loadSnapshots]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const select = useCallback(async (snapshotId: string) => {
    setSelected(snapshotId);
    setSelectedBody(null);
    setNotice(null);
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
    setError(null);
    try {
      const res = await fetch(
        `/api/notes/${encodeURIComponent(noteId)}/restore/${encodeURIComponent(snapshotId)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      onRestored(); // editor adopts the restored body
      // The restored snapshot's body is now the live body; the prior version was
      // archived by the API, so refresh the list to expose the undo target.
      if (selectedBody !== null) setLiveBody(selectedBody);
      setSelected(null);
      setSelectedBody(null);
      setNotice('Restored. To undo, restore the most recent version below.');
      await loadSnapshots();
    } catch {
      setError('Restore failed.');
    } finally {
      setRestoring(false);
    }
  }, [noteId, queryClient, onRestored, selectedBody, loadSnapshots]);

  const rows = selectedBody !== null ? lineDiff(selectedBody, liveBody) : null;

  return (
    <div
      className="snapshot-panel"
      role="dialog"
      aria-label="File recovery"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="snapshot-panel__sheet">
        <header className="snapshot-panel__head">
          <h2 className="snapshot-panel__title">File Recovery</h2>
          <button type="button" className="snapshot-panel__close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {error && <p className="snapshot-panel__error" role="alert">{error}</p>}
        {notice && <p className="snapshot-panel__notice" role="status">{notice}</p>}

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
            {selected === null && (
              <p className="snapshot-panel__muted">Pick a version to see what changed.</p>
            )}
            {selected !== null && rows === null && <p className="snapshot-panel__muted">Loading diff…</p>}
            {rows !== null && (
              <>
                <p className="snapshot-panel__legend">
                  <span className="snapshot-panel__swatch snapshot-panel__swatch--del" /> this version
                  <span className="snapshot-panel__swatch snapshot-panel__swatch--add" /> current
                </p>
                <div className="snapshot-panel__diffscroll">
                  {rows.map((r, i) => (
                    <div key={i} className={`snapshot-panel__row snapshot-panel__row--${r.kind}`}>
                      <span className="snapshot-panel__sign" aria-hidden="true">
                        {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
                      </span>
                      <code className="snapshot-panel__code">{r.text || ' '}</code>
                    </div>
                  ))}
                </div>
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
