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
}

// Build the host seam PapyraEditor reads its embeds through. This is the only
// data path out of the editor; every method points at Papyra's own API/router.
// Server-side PathGuard/401 is the real boundary — these resolvers just route to
// it. resolveBlock (transclusion) and onMentions (inbox) are deferred to Sprint
// 2.3, so they are omitted and the preset degrades them gracefully.
export function createPapyraEditorAdapter({ noteId, navigate, queryClient }: AdapterDeps): PapyraEditorAdapter {
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

    // [[Note]] activation → router push. Resolve by id when present, else match a
    // title against the notes cache; unknown targets are inert (no navigation).
    openNote: (ref) => {
      const id = ref.id ?? findByTitle(queryClient, ref.title)?.id;
      if (id) navigate(`/note/${id}`);
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
  };
}

function findByTitle(queryClient: QueryClient, title?: string): Note | undefined {
  if (!title) return undefined;
  const notes = queryClient.getQueryData<Note[]>(['notes']) ?? [];
  const t = title.trim().toLowerCase();
  return notes.find((n) => n.title.trim().toLowerCase() === t);
}
