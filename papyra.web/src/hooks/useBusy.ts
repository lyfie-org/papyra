import { useCallback, useEffect, useRef, useState } from 'react';
import { beginTask, type Task } from '../lib/progress';

/**
 * Busy state for one action: `run(work)` marks it busy until `work` settles and
 * ignores further runs meanwhile, so a second click (or Enter in a form) can't
 * send it twice. Pair it with a BusyButton (`busy={busy}`).
 *
 * Given a `label`, a run that takes a while also shows by name in the
 * ActivityDock — for work the person may scroll away from (a backup, a restore).
 */
export function useBusy(label?: string): [boolean, <T>(work: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    const task = label ? beginTask({ label }) : null;
    try {
      return await work();
    } finally {
      task?.end();
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [label]);

  return [busy, run];
}

/**
 * Keep a named card in the ActivityDock while `label` is set — for work the
 * server runs and the page only watches (a job, an import, a download).
 * `progress` (0..1) fills its bar when known.
 */
export function useActivityTask(label: string | null | false | undefined, progress: number | null = null) {
  const task = useRef<Task | null>(null);
  const on = Boolean(label);

  useEffect(() => {
    if (!on) return;
    const t = beginTask();
    task.current = t;
    return () => {
      t.end();
      task.current = null;
    };
  }, [on]);

  useEffect(() => {
    if (label) task.current?.label(label);
  }, [label, on]);

  useEffect(() => {
    if (progress !== null) task.current?.update(progress);
  }, [progress, on]);
}
