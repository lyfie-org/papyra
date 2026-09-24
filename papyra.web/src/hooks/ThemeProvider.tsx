import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ThemeContext, type Theme, type ThemePreference } from './useTheme';

const LS_KEY = 'papyra-theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialPreference(): ThemePreference {
  const saved = localStorage.getItem(LS_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
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

// Single source of truth for theme, shared by the toolbar toggle, the Settings
// Appearance panel, and the editor — so they never drift out of sync.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getInitialPreference);
  const [systemMode, setSystemMode] = useState<Theme>(systemTheme);

  const theme: Theme = preference === 'system' ? systemMode : preference;

  useEffect(() => { applyTheme(theme); }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    localStorage.setItem(LS_KEY, p);
    const next = p === 'system' ? systemTheme() : p;
    crossFade(() => {
      setPreferenceState(p);
      applyTheme(next);
    });
  }, []);

  // Track OS changes so 'system' stays live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => crossFade(() => setSystemMode(e.matches ? 'dark' : 'light'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Toggle is an explicit light/dark pick (leaves 'system' behind).
  const toggleTheme = useCallback(
    () => setPreference(theme === 'light' ? 'dark' : 'light'),
    [theme, setPreference],
  );

  const value = useMemo(
    () => ({ theme, preference, setPreference, toggleTheme }),
    [theme, preference, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
