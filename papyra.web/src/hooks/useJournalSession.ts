import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchEntry, saveEntry, JournalError } from '../lib/journalApi';
import { JOURNAL_KEY } from './useJournal';
import type { JournalEntry, JournalPatch, Mood } from '../types/journal';

export type JournalSaveStatus = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

const DEBOUNCE_MS = 1500;

/** The newer text another device wrote to this day while this draft was open. */
export interface JournalConflict {
  body: string;
  etag: string | null;
}

/**
 * One day open for writing.
 *
 * The editor is uncontrolled (luthor reads its text imperatively), so this hook
 * owns what surrounds it: the loaded entry and the ETag it was read with, the
 * debounced save (1.5 s after the last keystroke, flushed on leaving), the
 * newer-elsewhere conflict, mood and tags. A save names the revision it was
 * made against; if another device moved on, nothing is overwritten — the page
 * says so and the writer chooses. An empty page is not an entry: nothing is
 * saved until there is something to save.
 */
export function useJournalSession(date: string, unlockToken?: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...JOURNAL_KEY, 'entry', date, !!unlockToken],
    queryFn: () => fetchEntry(date, unlockToken),
    // Never refetched behind the writer's back: the hook merges what the server says on each save.
    staleTime: Infinity,
    gcTime: 0,
    retry: 1,
  });

  const loaded = query.data;
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  // The body the editor is mounted with. Adopting another body means remounting (a new key).
  const [initialBody, setInitialBody] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [status, setStatus] = useState<JournalSaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<JournalConflict | null>(null);

  const etag = useRef<string | null>(null);
  const saved = useRef('');
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const held = useRef(false); // a conflict is up: nothing is written until the writer chooses
  const adoptedFor = useRef<string | null>(null);

  // Adopt the first load of each day.
  const loadKey = loaded ? `${date}|${!!unlockToken}` : null;
  useLayoutEffect(() => {
    if (!loaded || !loadKey || adoptedFor.current === loadKey) return;
    adoptedFor.current = loadKey;
    etag.current = loaded.etag;
    saved.current = loaded.entry.body;
    latest.current = loaded.entry.body;
    held.current = false;
    // Adopting server state into editable local state is the point of this hook.
    setEntry(loaded.entry);
    setInitialBody(loaded.entry.body);
    setEditorKey((k) => k + 1);
    setStatus('idle');
    setError(null);
    setConflict(null);
  }, [loaded, loadKey]);

  const refreshAround = useCallback(() => {
    // The calendar, streak and today's card all read what was just written.
    for (const kind of ['range', 'stats', 'today', 'on-this-day']) {
      void queryClient.invalidateQueries({ queryKey: [...JOURNAL_KEY, kind] });
    }
  }, [queryClient]);

  /** Run saves one at a time so two never race on the ETag. */
  const enqueue = useCallback((work: () => Promise<void>) => {
    chain.current = chain.current.then(work, work);
    return chain.current;
  }, []);

  const send = useCallback(async (patch: JournalPatch, opts?: { force?: boolean }) => {
    setStatus('saving');
    try {
      const result = await saveEntry(date, patch, { baseHash: etag.current, forceSnapshot: opts?.force, unlockToken });
      if (result.status === 'queued') { setStatus('queued'); return; }
      if (result.status === 'stale') {
        held.current = true;
        setConflict({ body: result.body, etag: result.etag });
        setStatus('idle');
        return;
      }
      etag.current = result.etag ?? etag.current;
      if (patch.body !== undefined) saved.current = patch.body;
      setEntry((was) => ({ ...(was ?? result.entry), ...result.entry, body: patch.body !== undefined ? patch.body : (was?.body ?? result.entry.body) }));
      setError(null);
      setStatus('saved');
      refreshAround();
    } catch (err) {
      setStatus('error');
      setError(err instanceof JournalError ? err.message : 'Couldn’t save this day.');
    }
  }, [date, unlockToken, refreshAround]);

  /** Save the draft now, if it differs from what the server has. */
  const flush = useCallback((opts?: { force?: boolean }) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    return enqueue(async () => {
      if (held.current && !opts?.force) return;
      if (latest.current === saved.current && !opts?.force) return;
      // Nothing written yet and nothing typed: not an entry.
      if (!saved.current && !latest.current.trim() && !opts?.force) return;
      await send({ body: latest.current }, opts);
    });
  }, [enqueue, send]);

  /** The editor reported new markdown. */
  const onText = useCallback((markdown: string) => {
    if (markdown === latest.current) return;
    latest.current = markdown;
    if (held.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, DEBOUNCE_MS);
  }, [flush]);

  /** The editor's own first, normalised serialization: the baseline, not an edit. */
  const baseline = useCallback((markdown: string) => {
    if (saved.current === latest.current) {
      saved.current = markdown;
      latest.current = markdown;
    }
  }, []);

  const setMood = useCallback((mood: Mood | null) => {
    setEntry((was) => (was ? { ...was, mood, exists: true } : was));
    void enqueue(() => send({ mood }));
  }, [enqueue, send]);

  const setTags = useCallback((tags: string[]) => {
    setEntry((was) => (was ? { ...was, tags } : was));
    void enqueue(() => send({ tags }));
  }, [enqueue, send]);

  /** Another device wrote first: take its text (the draft stays in History as a version of its own). */
  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    etag.current = conflict.etag;
    saved.current = conflict.body;
    latest.current = conflict.body;
    held.current = false;
    setInitialBody(conflict.body);
    setEditorKey((k) => k + 1);
    setConflict(null);
    setStatus('idle');
    refreshAround();
  }, [conflict, refreshAround]);

  /** …or keep what was written here; the server archives the newer text first. */
  const keepMine = useCallback(() => {
    held.current = false;
    etag.current = conflict?.etag ?? etag.current;
    setConflict(null);
    // The base is the newer revision now, so the write names it and wins knowingly.
    return enqueue(() => send({ body: latest.current }, { force: true }));
  }, [conflict, enqueue, send]);

  /**
   * Replace the page with another body: a restored version, or a template to start from.
   * `quiet` is for text the person hasn't written yet — nothing is saved, so nothing says "Saved",
   * and an empty day stays no day at all until they add words of their own.
   */
  const adopt = useCallback((body: string, nextEtag?: string | null, opts?: { quiet?: boolean }) => {
    saved.current = body;
    latest.current = body;
    if (nextEtag !== undefined) etag.current = nextEtag;
    held.current = false;
    setInitialBody(body);
    setEditorKey((k) => k + 1);
    setConflict(null);
    if (opts?.quiet) return;
    setStatus('saved');
    refreshAround();
  }, [refreshAround]);

  // Leaving the page (or the tab going to the background on a phone) is a save.
  const flushRef = useRef(flush);
  useLayoutEffect(() => { flushRef.current = flush; }, [flush]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') void flushRef.current(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (timer.current) { clearTimeout(timer.current); void flushRef.current(); }
    };
  }, []);


  return {
    loading: query.isPending,
    loadError: query.error as Error | null,
    reload: () => { adoptedFor.current = null; return query.refetch(); },
    entry,
    etag,
    initialBody,
    editorKey,
    status,
    error,
    conflict,
    /** The text the editor holds right now. */
    readDraft: () => latest.current,
    onText,
    baseline,
    flush,
    setMood,
    setTags,
    takeTheirs,
    keepMine,
    adopt,
  };
}
