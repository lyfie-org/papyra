import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import type { PapyraEditorAdapter } from '@lyfie/luthor/presets/papyra';
import type { UploadFileOptions } from '@lyfie/luthor-headless';
import type { LexicalEditor } from 'lexical';
import type { Note } from '../types/note';
import { fetchWithProgress } from './progress';
import { mediaMetaStore, mediaUrl, toMediaMeta } from './mediaMeta';
import { createMediaToolbarItems } from './mediaToolbar';
import { checkMediaFile, loadMediaLimits } from './mediaLimits';
import { prepareUpload, uploadForm } from './uploadPrep';
import { renderPdfExpansion } from './pdfPreview';

/** The owner's own attachments. */
export const OWN_MEDIA = '/api/media';

// Inputs the adapter closes over: the open note (uploads tag against it), the
// router push, and the query client (the notes cache is the search/navigation
// source — the filesystem-backed in-memory vault, never a separate index).
interface AdapterDeps {
  noteId: string;
  navigate: NavigateFunction;
  queryClient: QueryClient;
  /**
   * Called when a `[[link]]` names no note this vault holds. The editor renders
   * every wikilink identically whether or not it resolves, so without this a
   * click on a dead one does nothing at all and explains nothing.
   */
  onUnresolvedLink?: (target: string) => void;
  /** Say why an upload failed or was refused (a toast). Called once per failure. */
  onUploadError?: (message: string) => void;
  /** The live editor, for toolbar actions that move an attachment. */
  getEditor?: () => LexicalEditor | null;
  /** A short confirmation (a toast): "Link copied". */
  notify?: (message: string) => void;
}

function uploadMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Couldn’t attach that file.';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

// Build the host seam PapyraEditor reads its embeds through. This is the only
// data path out of the editor; every method points at Papyra's own API/router.
// Server-side PathGuard/401 is the real boundary — these resolvers just route to
// it. onMentions is deliberately omitted: mention delivery is detected on the
// server at save time, because the notes PUT is also reachable from API keys,
// sharee edits and the public edit-link route, none of which run the editor.
export function createPapyraEditorAdapter(
  { noteId, navigate, queryClient, onUnresolvedLink, onUploadError, getEditor, notify }: AdapterDeps,
): PapyraEditorAdapter {
  const meta = mediaMetaStore(OWN_MEDIA);
  // The size limits, so an oversized file is refused before it is sent.
  void loadMediaLimits();

  // Dropped/pasted/picked file → stored attachment, referenced back as
  // ![[filename]]. A HEIC photo is converted and a video brings its poster
  // frame first (see uploadPrep). The response carries the file's metadata,
  // primed into the cache so the new embed has its size before its first frame.
  const uploadMedia = async (file: File, options?: UploadFileOptions) => {
    const prepared = await prepareUpload(file, options?.signal);
    const res = await fetchWithProgress(`${OWN_MEDIA}/upload?noteId=${encodeURIComponent(noteId)}`, {
      method: 'POST',
      body: uploadForm(prepared),
      signal: options?.signal,
      onProgress: options?.onProgress,
    });
    if (!res.ok) {
      // The server says why (too big for its kind, …) — pass that on.
      const data = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error ?? (res.status === 413 ? 'That file is too large to attach.' : 'Couldn’t attach that file.'));
    }
    const data = await res.json() as { filename: string } & Record<string, unknown>;
    meta.prime(data.filename, toMediaMeta(data));
    return { filename: data.filename };
  };

  return {
    // ![[file.ext]] → a URL the browser can GET: the original, or a
    // thumbnail/poster rendition (versioned, so cached for good). Media is flat
    // per user, so the bare filename is enough; PathGuard jails it server-side.
    resolveMediaUrl: (filename, options) => mediaUrl(OWN_MEDIA, filename, options, meta.get(filename)),
    getMediaMeta: (filename) => meta.get(filename),
    subscribeMediaMeta: (listener) => meta.subscribe(listener),
    // A PDF card previews in place (the browser's viewer, framed from /view).
    renderFileExpansion: renderPdfExpansion,

    uploadMedia,
    validateMedia: (file) => checkMediaFile(file),
    onUploadError: (error) => { if (!isAbort(error)) onUploadError?.(uploadMessage(error)); },

    // Replace / Move / Copy link / Download on a selected attachment. Replace
    // uploads outside the drop pipeline, so it checks and reports on its own.
    mediaToolbarItems: createMediaToolbarItems({
      getEditor,
      notify,
      upload: async (file) => {
        const refused = checkMediaFile(file);
        const error = refused ? new Error(refused) : null;
        try {
          if (error) throw error;
          return await uploadMedia(file);
        } catch (err) {
          if (!isAbort(err)) onUploadError?.(uploadMessage(err));
          throw err;
        }
      },
    }),

    // [[Note]] activation → router push.
    //
    // Resolution order: the id the editor already resolved, then a title match,
    // then the note's own filename. That last one matters because Papyra's whole
    // premise is that the vault is a folder of `.md` files you may edit anywhere
    // else — and Obsidian, the app people arrive from, links by filename. Only
    // matching titles meant `[[recipe-chai]]` was inert while `[[Chai, properly]]`
    // worked, for the same note, with nothing on screen to tell them apart.
    //
    // A target that matches nothing is reported rather than ignored: the link is
    // indistinguishable from a working one until it is clicked, so a click that
    // silently does nothing reads as the app being broken.
    openNote: (ref) => {
      const target = (ref.title ?? '').trim();
      const found = ref.id
        ?? findByTitle(queryClient, ref.title)?.id
        ?? findById(queryClient, target)?.id;
      if (found) { navigate(`/note/${found}`); return; }
      if (!target) return;
      onUnresolvedLink?.(target);
    },

    // ![[Note#^id]] → the text of that one block. The server serves the anchored
    // line and nothing else, refuses for a `secure: true` note, and 404s a note
    // the caller can't read — so an unresolvable reference is normal, not an
    // error, and returning null lets the preset render its unresolved chip.
    resolveBlock: async ({ note, blockId }) => {
      const id = findByTitle(queryClient, note)?.id ?? note;
      try {
        const res = await fetch(
          `/api/notes/${encodeURIComponent(id)}/blocks/${encodeURIComponent(blockId)}`,
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { text?: string };
        return data.text ?? null;
      } catch {
        return null; // offline: the chip stays unresolved rather than throwing
      }
    },

    // [[ typeahead → title substring match over the cached vault snapshot.
    searchNotes: async (query) => {
      const notes = queryClient.getQueryData<Note[]>(['notes']) ?? [];
      const q = query.trim().toLowerCase();
      return notes
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((n) => ({ id: n.id, title: n.title, color: n.color ?? undefined }));
    },

    // @ typeahead → GET /api/users/search?q=, a thin pass-through. The server
    // owns every real rule (2+ chars, prefix-only, self excluded, capped at 8,
    // rate-limited) — this just forwards the query and degrades to no
    // suggestions rather than throwing, same as resolveBlock does offline.
    searchUsers: async (query) => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return [];
        return (await res.json()) as { username: string; name: string }[];
      } catch {
        return [];
      }
    },
  };
}

function findByTitle(queryClient: QueryClient, title?: string): Note | undefined {
  if (!title) return undefined;
  const notes = queryClient.getQueryData<Note[]>(['notes']) ?? [];
  const t = title.trim().toLowerCase();
  return notes.find((n) => n.title.trim().toLowerCase() === t);
}

// A note's id is its filename on disk, which is what an Obsidian-style
// `[[recipe-chai]]` names. Trashed notes are skipped: linking to something in
// the bin should read as unresolved, not quietly reopen it.
function findById(queryClient: QueryClient, id: string): Note | undefined {
  if (!id) return undefined;
  const notes = queryClient.getQueryData<Note[]>(['notes']) ?? [];
  const wanted = id.trim().toLowerCase();
  return notes.find((n) => !n.trashed && n.id.trim().toLowerCase() === wanted);
}
