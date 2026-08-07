import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeContext, type Theme, type ThemePreference } from './useTheme';

const LS_KEY = 'papyra-theme';
const TRANSITION_MS = 300;

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialPreference(): ThemePreference {
  const saved = localStorage.getItem(LS_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

// Apply theme attribute and briefly add `.theme-transitioning` so the CSS
// transition block fires without affecting normal hover/focus states.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.add('theme-transitioning');
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  setTimeout(() => root.classList.remove('theme-transitioning'), TRANSITION_MS);
}

// Single source of truth for theme, shared by the toolbar toggle, the Settings
// Appearance panel, and the editor — so they never drift out of sync.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getInitialPreference);
  const [systemMode, setSystemMode] = useState<Theme>(systemTheme);

  const theme: Theme = preference === 'system' ? systemMode : preference;

  useEffect(() => { applyTheme(theme); }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    localStorage.setItem(LS_KEY, p);
  }, []);

  // Track OS changes so 'system' stays live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemMode(e.matches ? 'dark' : 'light');
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
