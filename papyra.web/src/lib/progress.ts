// App-wide activity store behind the top progress bar. Anything slow enough to be
// felt — an upload, a first load, an import — registers a task here; the bar shows
// while any task is open. A task that can measure itself (an upload's bytes, a
// download with a Content-Length) reports a real fraction; one that can't leaves
// it null and the bar trickles on its own.
//
// Framework-free so plain helpers (notesApi, the editor adapter) can use it; React
// reads it through useSyncExternalStore (see useActivity).

export interface Task {
  /** Real completion, 0..1. Never lowers what the bar already shows. */
  update(fraction: number): void;
  end(): void;
}

export interface Activity {
  /** Open tasks. */
  active: number;
  /** Mean real progress of the tasks that know theirs; null when none do. */
  progress: number | null;
}

const tasks = new Map<number, number | null>();
const listeners = new Set<() => void>();
let seq = 0;
let snapshot: Activity = { active: 0, progress: null };

function emit() {
  const known = [...tasks.values()].filter((p): p is number => p !== null);
  snapshot = {
    active: tasks.size,
    progress: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
  };
  listeners.forEach((l) => l());
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getActivity(): Activity {
  return snapshot;
}

export function beginTask(): Task {
  const id = ++seq;
  tasks.set(id, null);
  emit();
  return {
    update(fraction) {
      if (!tasks.has(id)) return;
      const f = Math.min(1, Math.max(0, fraction));
      if ((tasks.get(id) ?? 0) >= f) return;
      tasks.set(id, f);
      emit();
    },
    end() {
      if (tasks.delete(id)) emit();
    },
  };
}

/** Show the bar for as long as `work` runs (no measurable progress). */
export async function track<T>(work: Promise<T>): Promise<T> {
  const task = beginTask();
  try {
    return await work;
  } finally {
    task.end();
  }
}

type ProgressInit = RequestInit & { onProgress?: (fraction: number) => void };

const NULL_BODY = new Set([101, 204, 205, 304]);

function parseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* skip odd header */ }
    }
  }
  return headers;
}

// Uploads go through XHR — fetch still can't report upload progress. The upload
// is the first 90% of the bar; the server's answer is the rest.
function xhrWithProgress(url: string, init: ProgressInit, report: (f: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'POST', url);
    xhr.responseType = 'blob';
    new Headers(init.headers).forEach((v, k) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) report((e.loaded / e.total) * 0.9); };
    xhr.onprogress = (e) => { if (e.lengthComputable) report(0.9 + (e.loaded / e.total) * 0.1); };
    xhr.onload = () => {
      resolve(new Response(NULL_BODY.has(xhr.status) ? null : xhr.response, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: parseHeaders(xhr.getAllResponseHeaders()),
      }));
    };
    xhr.onerror = () => reject(new TypeError('Network request failed'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    init.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(init.body as XMLHttpRequestBodyInit | null);
  });
}

// A download that states its size is read chunk by chunk so the bar follows the
// bytes; one that doesn't (chunked JSON) is passed straight through.
async function streamWithProgress(res: Response, report: (f: number) => void): Promise<Response> {
  const total = Number(res.headers.get('Content-Length'));
  if (!res.body || !total || NULL_BODY.has(res.status)) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    report(loaded / total);
  }
  return new Response(new Blob(chunks as BlobPart[]), {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
}

/**
 * fetch() that drives the top bar — with real progress where the browser can
 * measure it (upload bytes; download bytes when sized), a trickle otherwise.
 * Same contract as fetch: resolves to a Response, rejects on network failure.
 */
export async function fetchWithProgress(url: string, init: ProgressInit = {}): Promise<Response> {
  const task = beginTask();
  const report = (f: number) => { task.update(f); init.onProgress?.(f); };
  try {
    const hasBody = init.body instanceof FormData || init.body instanceof Blob;
    // The browser demo answers from a fetch stub XHR can't see.
    if (hasBody && !import.meta.env.VITE_DEMO && typeof XMLHttpRequest !== 'undefined') {
      return await xhrWithProgress(url, init, report);
    }
    return await streamWithProgress(await fetch(url, init), report);
  } finally {
    task.end();
  }
}
