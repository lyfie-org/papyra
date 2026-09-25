import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, ChevronsUpDown, History, RotateCcw, X } from 'lucide-react';
import type { Note } from '../types/note';
import { lineDiff } from '../lib/lineDiff';
import { stripBlockAnchors } from '../lib/plainText';
import { vaultFetch } from '../lib/vault';
import {
  chronological, diffStats, foldUnchanged, formatStamp, relativeTime, type VersionMeta,
} from '../lib/history';
import './NoteHistory.css';

export type HistoryView = 'preview' | 'changes';

export interface HistoryVersion {
  title: string;
  body: string;
}

interface Props {
  noteId: string;
  /** The live note — the "Now" end of the timeline and the right side of every diff. */
  live: HistoryVersion;
  /** Show a version in the editor canvas; `null` puts the live note back. */
  onPreview: (version: HistoryVersion | null) => void;
  /** Restore a version (the editor owns the write and the undo). */
  onRestore: (snapshotId: string, label: string) => Promise<void>;
  onClose: () => void;
  view: HistoryView;
  onViewChange: (view: HistoryView) => void;
}

/**
 * A note's version history, inside the note itself.
 *
 * Replaces two overlapping features — a "time machine" scrub bar and a separate
 * "File Recovery" dialog stacked on top of the editor — with one mode: a timeline
 * bar pinned to the top of the note, the chosen version shown right in the
 * canvas (read-only), and a Changes view that diffs it against the note as it is
 * now, folding unchanged stretches so the change is what you see.
 *
 * The server lists distinct versions only (none identical to its neighbour or to
 * the live note), so every stop on the timeline is a real change.
 */
export default function NoteHistory({ noteId, live, onPreview, onRestore, onClose, view, onViewChange }: Props) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<HistoryVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const cache = useRef(new Map<string, HistoryVersion>());
  // The index whose body should land in the canvas; a slower earlier fetch that
  // resolves after the person has moved on must not overwrite the newer choice.
  const wanted = useRef(-1);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const count = versions?.length ?? 0;
  const atNow = versions !== null && index >= count;

  // ── Loading ──────────────────────────────────────────────────────────────

  const fetchVersion = useCallback(async (v: VersionMeta): Promise<HistoryVersion> => {
    const hit = cache.current.get(v.id);
    if (hit) return hit;
    const res = await vaultFetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots/${encodeURIComponent(v.id)}`);
    if (res.status === 401) throw new Error('locked');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const note = (await res.json()) as Note;
    const version = { title: note.title, body: note.body };
    cache.current.set(v.id, version);
    return version;
  }, [noteId]);

  // Select a stop: show that version (or Now) in the canvas, and warm its
  // neighbours so stepping and scrubbing feel instant.
  const show = useCallback((list: VersionMeta[], target: number) => {
    const i = Math.max(0, Math.min(list.length, target));
    if (i === wanted.current) return;
    wanted.current = i;
    setIndex(i);
    if (i >= list.length) {
      setLoaded(null);
      setError(null);
      onPreview(null);
      return;
    }
    const v = list[i];
    const hit = cache.current.get(v.id);
    setLoaded(hit ?? null);
    if (hit) { setError(null); onPreview(hit); }
    else {
      void fetchVersion(v).then((version) => {
        if (wanted.current !== i) return;
        setError(null);
        setLoaded(version);
        onPreview(version);
      }, (e: Error) => {
        if (wanted.current !== i) return;
        setError(e.message === 'locked' ? 'Unlock this note to see its history.' : 'Couldn’t load that version.');
      });
    }
    for (const n of [i - 1, i + 1]) {
      if (n >= 0 && n < list.length) void fetchVersion(list[n]).catch(() => {});
    }
  }, [fetchVersion, onPreview]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/snapshots`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = chronological((await res.json()) as VersionMeta[]);
        if (cancelled) return;
        setVersions(list);
        // Open on the most recent earlier version: that is what someone reaching
        // for history nearly always wants first. With none, park on Now.
        show(list, list.length > 0 ? list.length - 1 : 0);
      } catch {
        if (!cancelled) setError('Couldn’t load this note’s history.');
      }
    })();
    return () => { cancelled = true; };
    // Loaded once per note; `show` changing identity must not refetch the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // ── Navigation ───────────────────────────────────────────────────────────

  const go = useCallback((i: number) => {
    if (versions !== null) show(versions, i);
  }, [versions, show]);

  const indexAt = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || count === 0) return count;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * count);
  }, [count]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (count === 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    go(indexAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) go(indexAt(e.clientX));
  };
  const endDrag = () => { dragging.current = false; };

  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5,
    };
    if (e.key in step) { e.preventDefault(); go(index + step[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(count); }
  };

  // Esc leaves history (the editor's own Escape handler stands down meanwhile).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const selected = versions && !atNow ? versions[index] : null;
  const when = selected ? new Date(selected.timestamp) : null;
  const label = when ? formatStamp(when) : 'Now';

  const rows = useMemo(
    () => (loaded ? lineDiff(comparable(loaded.body), comparable(live.body)) : null),
    [loaded, live.body],
  );
  const stats = rows ? diffStats(rows) : null;
  const titleChanged = loaded !== null && loaded.title.trim() !== live.title.trim();

  const restore = async () => {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    try {
      await onRestore(selected.id, label);
    } catch {
      setError('Restore failed — nothing was changed.');
      setRestoring(false);
    }
  };

  const valueText = selected
    ? `Version from ${label}, ${relativeTime(when!)}`
    : 'Current version';

  return (
    <>
      <section className="note-history" aria-label="Version history">
        <div className="note-history__head">
          <span className="note-history__title"><History size={15} aria-hidden="true" /> History</span>

          <div className="note-history__when" aria-live="polite">
            {versions === null && !error && <span className="note-history__muted">Loading versions…</span>}
            {versions !== null && (
              <>
                <span className={`note-history__stamp${atNow ? ' is-now' : ''}`}>
                  {selected ? label : 'Current version'}
                </span>
                {when && <span className="note-history__ago">{relativeTime(when)}</span>}
                {stats && (stats.added > 0 || stats.removed > 0 || titleChanged) && (
                  <span className="note-history__stats" title="Compared with the note now">
                    {stats.removed > 0 && <span className="is-del">−{stats.removed}</span>}
                    {stats.added > 0 && <span className="is-add">+{stats.added}</span>}
                    {titleChanged && <span>title</span>}
                  </span>
                )}
              </>
            )}
          </div>

          <button type="button" className="note-history__icon" aria-label="Close history" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {versions !== null && count === 0 && (
          <p className="note-history__empty">
            No earlier versions yet. Papyra keeps one whenever this note changes (at most every few
            minutes) and holds them for 7 days.
          </p>
        )}

        {versions !== null && count > 0 && (
          <div className="note-history__timeline">
            <button
              type="button"
              className="note-history__icon"
              aria-label="Older version"
              disabled={index <= 0}
              onClick={() => go(index - 1)}
            >
              <ChevronLeft size={18} />
            </button>

            <div
              ref={trackRef}
              className={`note-history__track${count > 36 ? ' is-dense' : ''}`}
              role="slider"
              tabIndex={0}
              aria-label="Version timeline"
              aria-valuemin={0}
              aria-valuemax={count}
              aria-valuenow={index}
              aria-valuetext={valueText}
              onKeyDown={onTrackKey}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span className="note-history__rail" aria-hidden="true" />
              <span
                className="note-history__fill"
                aria-hidden="true"
                style={{ width: `${(index / count) * 100}%` }}
              />
              {versions.map((v, i) => (
                <span
                  key={v.id}
                  className={`note-history__stop${i === index ? ' is-active' : ''}`}
                  style={{ left: `${(i / count) * 100}%` }}
                  aria-hidden="true"
                  title={formatStamp(new Date(v.timestamp))}
                />
              ))}
              <span
                className={`note-history__stop note-history__stop--now${atNow ? ' is-active' : ''}`}
                style={{ left: '100%' }}
                aria-hidden="true"
                title="Now"
              />
            </div>

            <button
              type="button"
              className="note-history__icon"
              aria-label="Newer version"
              disabled={atNow}
              onClick={() => go(index + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}

        {error && <p className="note-history__error" role="alert">{error}</p>}

        {versions !== null && count > 0 && (
          <div className="note-history__actions">
            <div className="note-history__seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={view === 'preview'} onClick={() => onViewChange('preview')}>
                Preview
              </button>
              <button type="button" aria-pressed={view === 'changes'} onClick={() => onViewChange('changes')}>
                Changes
              </button>
            </div>
            <span className="note-history__pos">
              {atNow ? `${count} earlier version${count === 1 ? '' : 's'}` : `${index + 1} of ${count}`}
            </span>
            <button
              type="button"
              className="note-history__restore"
              disabled={atNow || restoring || loaded === null}
              onClick={() => void restore()}
            >
              <RotateCcw size={15} /> {restoring ? 'Restoring…' : 'Restore this version'}
            </button>
          </div>
        )}
      </section>

      {view === 'changes' && versions !== null && count > 0 && (
        <HistoryDiff
          // Keyed per version, so a new comparison always starts folded.
          key={selected?.id ?? 'now'}
          atNow={atNow}
          loading={!atNow && loaded === null && !error}
          rows={rows}
          titleChange={titleChanged && loaded ? { before: loaded.title, after: live.title } : null}
        />
      )}
    </>
  );
}

/**
 * A body as a reader compares it — the same noise the server's version
 * fingerprint ignores: hidden `^id` anchors (invisible in the editor, so a diff
 * showing them reads as stray characters), CRLF, trailing whitespace and a
 * trailing newline (a file on disk has one, the editor's draft does not).
 */
function comparable(body: string): string {
  return stripBlockAnchors(body.replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

function HistoryDiff({ atNow, loading, rows, titleChange }: {
  atNow: boolean;
  loading: boolean;
  rows: ReturnType<typeof lineDiff> | null;
  titleChange: { before: string; after: string } | null;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());

  if (atNow) {
    return <div className="note-history__diff"><p className="note-history__muted">This is the note as it is now. Pick an earlier version to compare.</p></div>;
  }
  if (loading || !rows) {
    return <div className="note-history__diff"><p className="note-history__muted">Loading changes…</p></div>;
  }

  const folded = foldUnchanged(rows);
  const unchanged = rows.every((r) => r.kind === 'same') && !titleChange;

  return (
    <div className="note-history__diff" role="region" aria-label="Changes since this version">
      <p className="note-history__legend">
        <span className="note-history__swatch note-history__swatch--del" /> in this version
        <span className="note-history__swatch note-history__swatch--add" /> in the note now
      </p>
      {titleChange && (
        <div className="note-history__titlediff">
          <span className="is-del">{titleChange.before || 'Untitled'}</span>
          <span aria-hidden="true">→</span>
          <span className="is-add">{titleChange.after || 'Untitled'}</span>
        </div>
      )}
      {unchanged && <p className="note-history__muted">Only formatting differs from the note now.</p>}
      <div className="note-history__rows">
        {folded.map((item, i) => item.type === 'fold' && !open.has(i) ? (
          <button
            key={i}
            type="button"
            className="note-history__fold"
            onClick={() => setOpen((s) => new Set(s).add(i))}
          >
            <ChevronsUpDown size={13} aria-hidden="true" /> {item.rows.length} unchanged lines
          </button>
        ) : (item.type === 'fold' ? item.rows : [item]).map((r, j) => (
          <div key={`${i}-${j}`} className={`note-history__row note-history__row--${r.kind}`}>
            <span className="note-history__sign" aria-hidden="true">
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
            </span>
            <code>{r.text || ' '}</code>
          </div>
        )))}
      </div>
    </div>
  );
}
