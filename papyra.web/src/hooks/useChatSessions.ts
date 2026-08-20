import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface Citation {
  noteId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdUtc: string;
  /** Present on assistant turns: the notes that answer was based on. */
  citations: Citation[] | null;
}

export interface ChatSessionSummary {
  id: number;
  title: string;
  model: string;
  provider: string;
  createdUtc: string;
  updatedUtc: string;
  messageCount: number;
}

export interface ChatThread {
  id: number;
  title: string;
  model: string;
  provider: string;
  updatedUtc: string;
  messages: ChatMessage[];
}

export const CHAT_SESSIONS_KEY = ['chat-sessions'] as const;
export const chatThreadKey = (id: number) => ['chat-session', id] as const;

/**
 * Conversations with the assistant.
 *
 * They exist so a follow-up question means something: the assistant used to
 * forget everything the moment the panel closed, which made "what about the
 * second one?" impossible to ask. A conversation belongs to one account and
 * never leaves it — it is a transcript of that person's notes.
 */
export function useChatSessions(enabled: boolean) {
  return useQuery({
    queryKey: CHAT_SESSIONS_KEY,
    enabled,
    queryFn: async (): Promise<ChatSessionSummary[]> => {
      const res = await fetch('/api/ai/sessions');
      if (!res.ok) throw new Error(`GET /api/ai/sessions failed: ${res.status}`);
      return res.json();
    },
  });
}

export function useChatThread(id: number | null) {
  return useQuery({
    queryKey: chatThreadKey(id ?? 0),
    enabled: id !== null,
    queryFn: async (): Promise<ChatThread> => {
      const res = await fetch(`/api/ai/sessions/${id}`);
      if (!res.ok) throw new Error(`GET /api/ai/sessions/${id} failed: ${res.status}`);
      return res.json();
    },
  });
}

export function useRenameChatSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      const res = await fetch(`/api/ai/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`PATCH session failed: ${res.status}`);
      return res.json() as Promise<{ id: number; title: string }>;
    },
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: CHAT_SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: chatThreadKey(id) });
    },
  });
}

export function useDeleteChatSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE session failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CHAT_SESSIONS_KEY }),
  });
}
