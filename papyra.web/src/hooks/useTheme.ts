import { createContext, useContext } from 'react';

// Preference is what the user chose; Theme is the resolved light/dark applied to
// the DOM. 'system' follows the OS and reacts to OS changes live.
export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export interface ThemeContextValue {
  /** Resolved light/dark currently applied. */
  theme: Theme;
  /** The user's stored choice (may be 'system'). */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggleTheme: () => void;
}

// The context + hook live apart from <ThemeProvider/> so this module exports no
// components — that keeps React Fast Refresh working for the provider file
// (react-refresh/only-export-components).
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
