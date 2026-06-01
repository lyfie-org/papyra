import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const LS_KEY = 'papyra-theme';
const TRANSITION_MS = 300;

/** Read saved preference, then fall back to OS setting. */
function getInitialTheme(): Theme {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Apply theme attribute and briefly add `.theme-transitioning` so the
 * CSS transition block fires without affecting normal hover/focus states.
 */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.add('theme-transitioning');
  root.setAttribute('data-theme', theme);
  // `color-scheme` tells the browser to style native UI (scrollbars, inputs)
  root.style.colorScheme = theme;
  setTimeout(() => root.classList.remove('theme-transitioning'), TRANSITION_MS);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  // Keep DOM in sync whenever theme changes
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(LS_KEY, theme);
  }, [theme]);

  // Also react to OS-level changes (e.g. user switches system preference while
  // the app is open) — only when the user has no explicit saved choice.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem(LS_KEY)) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(t => (t === 'light' ? 'dark' : 'light')),
    [],
  );

  return { theme, toggleTheme } as const;
}
