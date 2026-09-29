import { APP_VERSION_LABEL } from './appInfo';

/**
 * One failure, in the shape the error screens show and the "Copy error
 * details" button copies. Either the server's (it sends an errorId that finds
 * its log line, plus a trimmed stack) or the browser's own (a render crash).
 */
export interface ErrorInfo {
  title: string;
  message: string;
  /** The server's reference ("E7K2-QX9M"), when the failure was the server's. */
  errorId?: string | null;
  status?: number | null;
  /** Trimmed stack: the server's, or this bundle's. */
  stack?: string | null;
  /** Where in the React tree a render crash happened. */
  componentStack?: string | null;
  /** Which request failed (server errors). */
  request?: string | null;
  serverVersion?: string | null;
  time?: string;
}

/** The server's error body (see ErrorPages.cs). */
interface ServerErrorBody {
  error?: string;
  code?: string;
  errorId?: string;
  detail?: {
    type?: string | null; message?: string | null; stack?: string | null;
    method?: string; path?: string; time?: string; version?: string;
  } | null;
}

/** An ErrorInfo from a failed response's JSON, if the server sent its error shape. */
export function serverErrorInfo(body: unknown, status: number): ErrorInfo | null {
  const b = body as ServerErrorBody | null;
  if (!b || typeof b !== 'object' || typeof b.errorId !== 'string') return null;
  return {
    title: 'Something went wrong on the server',
    message: b.error ?? 'Papyra hit an unexpected error.',
    errorId: b.errorId,
    status,
    stack: b.detail?.stack ?? null,
    request: b.detail?.method && b.detail.path ? `${b.detail.method} ${b.detail.path}` : null,
    serverVersion: b.detail?.version ?? null,
    time: b.detail?.time ?? new Date().toISOString(),
  };
}

/** An ErrorInfo for something that threw in the browser. */
export function clientErrorInfo(error: unknown, componentStack?: string | null): ErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    title: 'Something went wrong',
    message: 'This screen hit an unexpected error. Your notes are safe — they live on the server.',
    stack: `${err.name}: ${err.message}${err.stack ? `\n${trimClientStack(err.stack, err)}` : ''}`,
    componentStack: componentStack
      ? componentStack.trim().split('\n').slice(0, 12).map(l => l.trim()).join('\n')
      : null,
    time: new Date().toISOString(),
  };
}

// Chrome repeats "Name: message" as the stack's first line; frames are enough.
// Bundle URLs shrink to the file name — the origin is the same for everyone.
function trimClientStack(stack: string, err: Error): string {
  return stack
    .split('\n')
    .filter((line, i) => !(i === 0 && line.includes(err.message)))
    .slice(0, 18)
    .map(line => line.trim().replace(/\(?https?:\/\/[^/\s]+\/(?:[^\s)]*\/)?([^/\s)]+)\)?/g, '($1)'))
    .join('\n');
}

/** The plain-text report someone pastes into a message to the admin. */
export function errorReportText(info: ErrorInfo): string {
  const lines = [
    `Papyra error${info.errorId ? ` ${info.errorId}` : ''}: ${info.title}`,
    `Time:     ${info.time ?? new Date().toISOString()}`,
    `Page:     ${window.location.pathname}${window.location.search}`,
  ];
  if (info.request) lines.push(`Request:  ${info.request}${info.status ? ` → ${info.status}` : ''}`);
  else if (info.status) lines.push(`Status:   ${info.status}`);
  lines.push(`App:      ${APP_VERSION_LABEL}${info.serverVersion ? ` (server ${info.serverVersion})` : ''}`);
  lines.push(`Browser:  ${navigator.userAgent}`);
  if (info.stack) lines.push('', info.stack);
  if (info.componentStack) lines.push('', 'Component tree:', info.componentStack);
  return lines.join('\n');
}

// ── Server errors from anywhere ───────────────────────────────────────────────
// Dozens of call sites fetch; most turn a failure into their own short message
// ("Couldn't save"). The reference and trace would be lost there, so a thin
// wrapper around fetch notices the server's error shape on any 5xx and tells
// whoever listens (ServerErrorNotices) — without touching the response the
// caller reads.

type Listener = (info: ErrorInfo) => void;
const listeners = new Set<Listener>();

export function onServerError(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let installed = false;

export function installServerErrorWatch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if (res.status >= 500 && listeners.size > 0 && res.headers.get('content-type')?.includes('application/json')) {
      res.clone().json()
        .then((body: unknown) => {
          const info = serverErrorInfo(body, res.status);
          if (info) listeners.forEach(fn => fn(info));
        })
        .catch(() => { /* not the server's error shape */ });
    }
    return res;
  };
}
