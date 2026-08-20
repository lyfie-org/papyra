import type { QueryClient } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import type { PapyraEditorAdapter } from '@lyfie/luthor/presets/papyra';
import type { Note } from '../types/note';

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
}

// Build the host seam PapyraEditor reads its embeds through. This is the only
// data path out of the editor; every method points at Papyra's own API/router.
// Server-side PathGuard/401 is the real boundary — these resolvers just route to
// it. onMentions is deliberately omitted: mention delivery is detected on the
// server at save time, because the notes PUT is also reachable from API keys,
// sharee edits and the public edit-link route, none of which run the editor.
export function createPapyraEditorAdapter(
  { noteId, navigate, queryClient, onUnresolvedLink }: AdapterDeps,
): PapyraEditorAdapter {
  return {
    // ![[file.ext]] → a URL the browser can GET. Media is flat per-user, so the
    // bare filename is enough; PathGuard jails it server-side.
    resolveMediaUrl: (filename) => `/api/media/${encodeURIComponent(filename)}`,

    // Dropped/pasted blob → stored attachment, referenced back as ![[filename]].
    uploadMedia: async (file) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/media/upload?noteId=${encodeURIComponent(noteId)}`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`media upload failed: ${res.status}`);
      return res.json() as Promise<{ filename: string }>;
    },

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
