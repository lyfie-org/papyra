import type { ErrorAction } from '../components/ErrorPanel';

/** Reload, and home — the two ways out of a crash. Plain navigations: the router may be what broke. */
export const crashActions: ErrorAction[] = [
  { label: 'Reload', onClick: () => window.location.reload(), primary: true },
  { label: 'Back to notes', onClick: () => { window.location.href = '/'; } },
];
