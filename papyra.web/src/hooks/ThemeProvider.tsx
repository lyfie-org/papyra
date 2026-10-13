import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ThemeContext, type Theme, type ThemePreference } from './useTheme';
import {
  DEFAULT_SCHEDULE, msUntilNextChange, parseSchedule, serializeSchedule, themeAt, type ThemeSchedule,
} from '../lib/themeSchedule';

const LS_KEY = 'papyra-theme';
// The schedule's times, kept while another preference is on so picking
// "Scheduled" again brings them back.
const LS_SCHEDULE_KEY = 'papyra-theme-schedule';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; /* storage blocked */ }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

/** A stored theme, or null when it isn't one we know. */
function normalizeWire(saved: string | null): string | null {
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return parseSchedule(saved) ? saved : null;
}

function getInitialWire(): string {
  const saved = normalizeWire(read(LS_KEY));
  if (saved) return saved;
  // Someone opening a public share link has never been here: show the note on
  // paper, as it was written. The page has a toggle, and their pick sticks.
  if (window.location.pathname.startsWith('/shared/')) return 'light';
  return 'system';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  // The installed app's status bar follows the page (--bg in each theme).
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#1c1917' : '#f2ebe0');
}

/**
 * Run a theme change as one cross-fade.
 *
 * The old approach put a CSS transition on every element for 300ms. On a desk of
 * a few hundred notes that is ~9k elements each starting four transitions, and
 * the browser spent a second or more restyling before it could draw a frame —
 * then the class came off before the 320ms transitions finished, so colours
 * snapped at the end. A view transition instead snapshots the page, applies the
 * new theme in one restyle, and fades between two bitmaps on the compositor:
 * the cost no longer grows with the number of notes. Reduced motion, or a
 * browser without the API, just switches.
 */
function crossFade(update: () => void) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  // flushSync so React's re-render (the editor's theme, the toggle's icon) lands
  // inside the "after" snapshot rather than a frame later.
  document.startViewTransition(() => flushSync(update));
}

function resolve(wire: string, systemMode: Theme, now: Date): Theme {
  const schedule = parseSchedule(wire);
  if (schedule) return themeAt(schedule, now);
  return wire === 'system' ? systemMode : (wire as Theme);
}

// Single source of truth for theme, shared by the toolbar toggle, the Settings
// Appearance panel, and the editor — so they never drift out of sync.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [wire, setWireState] = useState<string>(getInitialWire);
  const [systemMode, setSystemMode] = useState<Theme>(systemTheme);
  // The clock a schedule is read against: moved on at each switch-over, and
  // whenever the page comes back (a sleeping laptop misses its timers).
  const [now, setNow] = useState(() => new Date());
  const [lastSchedule, setLastSchedule] = useState<ThemeSchedule>(
    () => parseSchedule(wire) ?? parseSchedule(read(LS_SCHEDULE_KEY)) ?? DEFAULT_SCHEDULE);

  const schedule = parseSchedule(wire);
  const preference: ThemePreference = schedule ? 'schedule' : (wire as ThemePreference);
  const theme = resolve(wire, systemMode, now);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const setWire = useCallback((next: string) => {
    const value = normalizeWire(next);
    if (!value) return;
    write(LS_KEY, value);
    const scheduled = parseSchedule(value);
    if (scheduled) {
      write(LS_SCHEDULE_KEY, value);
      setLastSchedule(scheduled);
    }
    const at = new Date();
    crossFade(() => {
      setNow(at);
      setWireState(value);
      applyTheme(resolve(value, systemTheme(), at));
    });
  }, []);

  const setPreference = useCallback((p: ThemePreference) => {
    setWire(p === 'schedule' ? serializeSchedule(lastSchedule) : p);
  }, [setWire, lastSchedule]);

  const setSchedule = useCallback((s: ThemeSchedule) => setWire(serializeSchedule(s)), [setWire]);

  // Track OS changes so 'system' stays live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => crossFade(() => setSystemMode(e.matches ? 'dark' : 'light'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // A schedule switches at its times, and catches up when the page is seen again.
  useEffect(() => {
    const active = parseSchedule(wire);
    if (!active) return;
    const tick = () => {
      const at = new Date();
      if (themeAt(active, at) !== theme) crossFade(() => setNow(at));
      else setNow(at);
    };
    const timer = setTimeout(tick, msUntilNextChange(active, now) + 500);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [wire, now, theme]);

  // Toggle is an explicit light/dark pick (leaves 'system' or a schedule behind).
  const toggleTheme = useCallback(
    () => setPreference(theme === 'light' ? 'dark' : 'light'),
    [theme, setPreference],
  );

  const value = useMemo(
    () => ({ theme, preference, setPreference, schedule: lastSchedule, setSchedule, wire, setWire, toggleTheme }),
    [theme, preference, setPreference, lastSchedule, setSchedule, wire, setWire, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
