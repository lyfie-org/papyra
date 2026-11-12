import { fetchWithProgress } from './progress';

/** A note's title as a file name, as the server names it: no path characters, at most 80 long. */
export function noteFileBase(title: string): string {
  // eslint-disable-next-line no-control-regex
  const base = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.slice(0, 80).trim() || 'Untitled';
}

/**
 * Save a note the server has prepared: a plain .md, or — when the note embeds
 * pictures or files — a .zip with the .md and its attachments under `media/`.
 * The server decides, so the name follows what came back. Rejects with a
 * sentence fit for a toast.
 */
export async function downloadNote(url: string, title: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithProgress(url, { label: 'Preparing download' });
  } catch {
    throw new Error('Couldn’t download the note — the server is unreachable.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `Couldn’t download the note (${res.status}).`);
  }
  const zipped = (res.headers.get('Content-Type') ?? '').includes('zip');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = noteFileBase(title) + (zipped ? '.zip' : '.md');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
