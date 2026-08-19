import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfirm } from '../lib/confirmContext';
import { useToast } from '../lib/toastContext';
import { newMentions } from '../lib/mentions';

/**
 * Offers to share a note with the people just mentioned in it.
 *
 * Typing `@bea` used to deliver one paragraph to Bea's inbox and nothing else,
 * which is safe and almost always wrong: the paragraph refers to the note it
 * came from, and Bea would open it to a wall saying she isn't allowed in. So a
 * mention now offers the whole note — but only offers. Sharing somebody's
 * writing is a decision, and it happens when they say yes, never as a side
 * effect of a save.
 *
 * Declining is remembered for the session, so a note that keeps saving does not
 * keep asking about a name the author already said no to.
 */
export function useMentionShare(noteId: string, secure: boolean | undefined) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Names already handled — shared, declined, or unknown — for this editor.
  const settled = useRef(new Set<string>());

  return useCallback(async (priorBody: string, nextBody: string) => {
    // A locked note's body is withheld, so there is nothing to mention in, and
    // the API refuses to share it anyway.
    if (secure) return;

    const fresh = newMentions(priorBody, nextBody)
      .filter(name => !settled.current.has(name.toLowerCase()));
    if (fresh.length === 0) return;

    for (const name of fresh) {
      settled.current.add(name.toLowerCase());

      const ok = await confirm({
        title: `Share this note with @${name}?`,
        body: `They already get the paragraph you named them in. Sharing the whole note lets them open it and read the rest — you can take that back at any time from the note's share menu.`,
        confirmLabel: 'Share the note',
        cancelLabel: 'Just the paragraph',
      });
      if (!ok) continue;

      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'user', access: 'view', granteeUsername: name }),
      });

      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ['shares', noteId] });
        await queryClient.invalidateQueries({ queryKey: ['shares', 'summary'] });
        toast(`Shared with @${name}.`);
        continue;
      }
      // 404 is the ordinary case, not a fault: an `@` in prose that happens to
      // look like a username belongs to nobody. Say nothing.
      if (res.status === 404) continue;
      const data = await res.json().catch(() => null) as { error?: string } | null;
      toast(data?.error ?? `Couldn’t share with @${name}.`);
    }
  }, [confirm, noteId, queryClient, secure, toast]);
}
