// How big an attachment may be, by kind — fetched from the server
// (`GET /api/media/limits`, the same table the upload enforces), so a 600 MB
// video is refused before a byte is sent rather than after the whole file has
// crawled up. The server stays the authority: it decides by the file's bytes,
// this only by its extension, and until the table has loaded every file passes.

export interface MediaLimitTable {
  limits: { image: number; gif: number; audio: number; video: number; document: number; other: number };
  extensions: { image: string[]; audio: string[]; video: string[]; document: string[] };
}

type Kind = keyof MediaLimitTable['limits'];

const LABEL: Record<Kind, string> = {
  image: 'image', gif: 'GIF', audio: 'audio file', video: 'video', document: 'document', other: 'file',
};

let table: MediaLimitTable | null = null;
let loading: Promise<MediaLimitTable | null> | null = null;

/** Fetch the table once per page (again after a failure). */
export function loadMediaLimits(fetcher: typeof fetch = (...a) => fetch(...a)): Promise<MediaLimitTable | null> {
  if (table) return Promise.resolve(table);
  loading ??= fetcher('/api/media/limits')
    .then(async (res) => (res.ok ? (table = (await res.json()) as MediaLimitTable) : null))
    .catch(() => null)
    .finally(() => { loading = null; });
  return loading;
}

/** For tests. */
export function setMediaLimits(next: MediaLimitTable | null): void {
  table = next;
}

function kindOf(name: string, t: MediaLimitTable): Kind {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (ext === '.gif') return 'gif';
  if (t.extensions.image.includes(ext)) return 'image';
  if (t.extensions.video.includes(ext)) return 'video';
  if (t.extensions.audio.includes(ext)) return 'audio';
  if (t.extensions.document.includes(ext)) return 'document';
  return 'other';
}

function human(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb ? `${Math.round((bytes / mb) * 10) / 10} MB` : `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

/**
 * Why this file won't be accepted, in the server's own words — or null. An
 * empty file is refused too (the server would answer "No file.").
 */
export function checkMediaFile(file: File, t: MediaLimitTable | null = table): string | null {
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (!t) return null;
  const kind = kindOf(file.name, t);
  const limit = t.limits[kind];
  if (!limit || file.size <= limit) return null;
  const label = LABEL[kind];
  return `That ${label} is over the ${human(limit)} limit for ${label}s.`;
}
