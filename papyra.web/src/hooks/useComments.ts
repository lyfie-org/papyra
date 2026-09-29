import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TextQuote } from '../lib/textAnchor';

/** Which note: your own (`noteId`) or one shared with you (`shareId`) — as the live room addresses it. */
export type CommentTarget = { noteId: string } | { shareId: number };

export interface CommentPerson {
  id: number;
  username: string;
  name: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  people: string[];
}

export interface NoteCommentItem {
  id: number;
  author: CommentPerson;
  body: string;
  createdUtc: string;
  editedUtc: string | null;
  canEdit: boolean;
  canDelete: boolean;
  reactions: Reaction[];
}

export interface CommentThread {
  id: number;
  quote: TextQuote | null;
  resolved: boolean;
  resolvedUtc: string | null;
  resolvedBy: CommentPerson | null;
  createdUtc: string;
  canResolve: boolean;
  comments: NoteCommentItem[];
}

export interface CommentsData {
  ownerId: number;
  noteId: string;
  me: CommentPerson;
  reactions: string[];
  people: CommentPerson[];
  threads: CommentThread[];
}

function query(target: CommentTarget): string {
  return 'noteId' in target ? `note=${encodeURIComponent(target.noteId)}` : `share=${target.shareId}`;
}

const key = (target: CommentTarget | null) => ['comments', target ? query(target) : 'none'] as const;

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `Couldn’t save the comment (${res.status}).`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * A note's comment threads, live: the server pushes CommentsChanged to
 * everyone who can see the note (useSignalR invalidates ['comments']).
 */
export function useComments(target: CommentTarget | null) {
  const queryClient = useQueryClient();
  const k = key(target);

  const threads = useQuery({
    queryKey: k,
    enabled: target !== null,
    queryFn: async (): Promise<CommentsData | null> => {
      const res = await fetch(`/api/comments?${query(target!)}`);
      // Locked, gone, or no longer shared: no comments to show.
      if (res.status === 404 || res.status === 409) return null;
      if (!res.ok) throw new Error(`GET comments failed: ${res.status}`);
      return res.json() as Promise<CommentsData>;
    },
    staleTime: 15_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: k });

  const create = useMutation({
    mutationFn: (input: { body: string; quote?: TextQuote | null; threadId?: number }) =>
      send(`/api/comments?${query(target!)}`, 'POST', input) as Promise<{ id: number; threadId: number }>,
    onSettled: refresh,
  });
  const edit = useMutation({
    mutationFn: (input: { id: number; body: string }) => send(`/api/comments/${input.id}`, 'PUT', { body: input.body }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => send(`/api/comments/${id}`, 'DELETE'),
    onSettled: refresh,
  });
  const resolve = useMutation({
    mutationFn: (input: { id: number; resolved: boolean }) =>
      send(`/api/comments/${input.id}/resolve`, 'POST', { resolved: input.resolved }),
    onSettled: refresh,
  });
  const react = useMutation({
    mutationFn: (input: { id: number; emoji: string }) =>
      send(`/api/comments/${input.id}/reactions`, 'POST', { emoji: input.emoji }),
    // Reactions flip at once; the refetch confirms.
    onMutate: async ({ id, emoji }) => {
      await queryClient.cancelQueries({ queryKey: k });
      const prev = queryClient.getQueryData<CommentsData | null>(k);
      if (prev) {
        queryClient.setQueryData<CommentsData>(k, {
          ...prev,
          threads: prev.threads.map(t => ({
            ...t,
            comments: t.comments.map(c => c.id !== id ? c : { ...c, reactions: toggle(c.reactions, emoji, prev.me.username, prev.reactions) }),
          })),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) queryClient.setQueryData(k, ctx.prev); },
    onSettled: refresh,
  });

  return { data: threads.data ?? null, isLoading: threads.isLoading, create, edit, remove, resolve, react };
}

export function toggle(reactions: Reaction[], emoji: string, me: string, order: string[]): Reaction[] {
  const existing = reactions.find(r => r.emoji === emoji);
  if (existing?.mine) {
    return reactions
      .map(r => r.emoji !== emoji ? r : { ...r, count: r.count - 1, mine: false, people: r.people.filter(p => p !== me) })
      .filter(r => r.count > 0);
  }
  const next = existing
    ? reactions.map(r => r.emoji !== emoji ? r : { ...r, count: r.count + 1, mine: true, people: [...r.people, me] })
    : [...reactions, { emoji, count: 1, mine: true, people: [me] }];
  return next.sort((a, b) => order.indexOf(a.emoji) - order.indexOf(b.emoji));
}
