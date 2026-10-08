import { clientErrorInfo } from './errorReport';

/**
 * Browser crashes, sent to the instance's log (Settings → Logs, as "Browser").
 *
 * Nothing personal leaves the page: the route goes as a pattern ("/note/:id",
 * never the note's id), the stack is this bundle's frames with URLs trimmed to
 * file names, and the server scrubs the message again before keeping it.
 * Fire-and-forget, at most a handful per page load, each distinct error once.
 */

// First path segments that name a screen rather than a thing; everything after
// them (a note id, a share token) becomes a placeholder.
const SCREENS = new Set([
  'note', 'shared', 'settings', 'todo', 'collections', 'shared-with-me', 'vault', 'archive',
  'trash', 'login', 'setup', 'reset-password', 'accept-invite', 'admin', 'inbox', 'categories',
]);

/** "/note/My Diary" → "/note/:id"; "/" stays "/". */
export function routePattern(pathname: string): string {
  const [first, ...rest] = pathname.split('/').filter(Boolean);
  if (!first) return '/';
  const head = SCREENS.has(first) ? first : ':page';
  return ['', head, ...rest.map(() => ':id')].join('/');
}

const MAX_PER_PAGE = 5;
const seen = new Set<string>();

export function reportClientError(error: unknown, componentStack?: string | null): void {
  if (import.meta.env.VITE_DEMO || typeof window === 'undefined') return;
  const err = error instanceof Error ? error : new Error(String(error));
  const key = `${err.name}: ${err.message}`;
  if (seen.has(key) || seen.size >= MAX_PER_PAGE) return;
  seen.add(key);
  const info = clientErrorInfo(err, componentStack);
  void fetch('/api/logs/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: err.message || err.name,
      type: err.name,
      stack: info.stack,
      componentStack: info.componentStack,
      route: routePattern(window.location.pathname),
    }),
    keepalive: true,
  }).catch(() => { /* the log is a convenience; never a second error */ });
}

let installed = false;

/** Uncaught errors and rejections anywhere on the page. */
export function installClientErrorLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // A failed <img>/<script> fires here too, with no error object — not a crash.
    if (e.error) reportClientError(e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    // A cancelled fetch (navigating away, a superseded query) is not a fault.
    if (reason instanceof DOMException && reason.name === 'AbortError') return;
    if (reason instanceof Error) reportClientError(reason);
  });
}
