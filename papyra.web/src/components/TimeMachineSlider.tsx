import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import type { Note } from '../types/note';
import './TimeMachineSlider.css';

interface SnapshotMeta {
  id: string;
  timestamp: string;
}

// A scrub bar over a note's version history. Dragging the slider previews each
// archived revision live in the editor; the right end is "Now" (the live draft).
// Previewing NEVER writes to disk — the editor's autosave is suppressed by the
// parent while this is mounted; only "Restore this version" persists a revision.
interface Props {
  noteId: string;
  liveBody: string;
  onPreview: (body: string) => void;
  onRestore: (snapshotId: string) => Promise<void>;
  onClose: () => void;
}

export default function TimeMachineSlider({ noteId, liveBody, onPreview, onRestore, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [index, setIndex] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bodies fetched per snapshot, cached so re-scrubbing doesn't refetch.
  const bodies = useRef(new Map<string, string>());

  // Load the history, oldest → newest; the slider's far right (= length) is "Now".
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = ((await res.json()) as SnapshotMeta[])
          .slice()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        setSnapshots(list);
        setIndex(list.length); // start parked on "Now"
      } catch {
        setError('Could not load version history.');
      }
    })();
  }, [noteId]);

  // Esc exits the time machine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const scrubTo = useCallback(async (i: number) => {
    setIndex(i);
    if (!snapshots || i >= snapshots.length) { onPreview(liveBody); return; }
    const snap = snapshots[i];
    const cached = bodies.current.get(snap.id);
    if (cached !== undefined) { onPreview(cached); return; }
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots/${encodeURIComponent(snap.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const note = (await res.json()) as Note;
      bodies.current.set(snap.id, note.body);
      onPreview(note.body);
    } catch {
      setError('Could not load that revision.');
    }
  }, [snapshots, liveBody, noteId, onPreview]);

  const atNow = !snapshots || index >= snapshots.length;
  const label = atNow ? 'Now' : new Date(snapshots![index].timestamp).toLocaleString();

  const restore = useCallback(async () => {
    if (atNow || !snapshots) return;
    setRestoring(true);
    setError(null);
    try {
      await onRestore(snapshots[index].id);
    } catch {
      setError('Restore failed.');
      setRestoring(false);
    }
  }, [atNow, snapshots, index, onRestore]);

  return (
    <section className="time-machine" aria-label="Time machine">
      <div className="time-machine__row">
        <span className="time-machine__label">Time Machine</span>
        <button type="button" className="time-machine__close" aria-label="Exit time machine" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {error && <p className="time-machine__error" role="alert">{error}</p>}

      {snapshots && snapshots.length === 0 ? (
        <p className="time-machine__empty">No earlier versions yet.</p>
      ) : (
        <div className="time-machine__controls">
          <input
            className="time-machine__range"
            type="range"
            min={0}
            max={snapshots?.length ?? 0}
            value={index}
            disabled={!snapshots || restoring}
            aria-label="Scrub through version history"
            onChange={(e) => void scrubTo(Number(e.target.value))}
          />
          <span className={`time-machine__stamp${atNow ? ' is-now' : ''}`}>{label}</span>
          <button
            type="button"
            className="time-machine__restore"
            disabled={atNow || restoring}
            onClick={() => void restore()}
          >
            <RotateCcw size={15} /> {restoring ? 'Restoring…' : 'Restore this version'}
          </button>
        </div>
      )}
    </section>
  );
}
