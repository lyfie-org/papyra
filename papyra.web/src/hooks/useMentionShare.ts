import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useShareOffer } from '../lib/shareOfferContext';
import { useToast } from '../lib/toastContext';
import { newMentions } from '../lib/mentions';

interface Existing { kind: string; grantee: string | null }
interface Suggestion { username: string }

/**
 * Offers to share a note with the people just mentioned in it.
 *
 * Access is the whole note or nothing, so a mention on its own only notifies:
 * the person sees who mentioned them and can ask for access. What makes it
 * collaborative is this offer — "Share with @bea?" with a role (edit by
 * default, or view) — asked right after the save that introduced the name,
 * the way Google Docs asks when you @-mention someone without access.
 *
 * Only real accounts that can't already open the note are offered, in one
 * dialog per save. Anything settled — shared, declined, not a user — is not
 * asked about again for the life of this editor.
 */
export function useMentionShare(noteId: string, secure: boolean | undefined, getTitle: () => string = () => '') {
  const offer = useShareOffer();
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
    fresh.forEach(name => settled.current.add(name.toLowerCase()));

    // Who already has it: no point asking to share with them again.
    const sharesRes = await fetch(`/api/notes/${encodeURIComponent(noteId)}/shares`).catch(() => null);
    const existing: Existing[] = sharesRes?.ok ? await sharesRes.json() : [];
    const holders = new Set(existing.filter(s => s.kind === 'user' && s.grantee)
      .map(s => s.grantee!.toLowerCase()));

    // "@ the shops" or a handle from another service is prose, not a person.
    const real: string[] = [];
    for (const name of fresh) {
      if (holders.has(name.toLowerCase())) continue;
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(name)}`).catch(() => null);
      const found: Suggestion[] = res?.ok ? await res.json() : [];
      const match = found.find(u => u.username.toLowerCase() === name.toLowerCase());
      if (match) real.push(match.username);
    }
    if (real.length === 0) return;

    const answer = await offer({ names: real, noteTitle: getTitle() });
    if (!answer) return;

    const shared: string[] = [];
    for (const name of real) {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'user', access: answer.access, granteeUsername: name }),
      });
      if (res.ok) { shared.push(name); continue; }
      const data = await res.json().catch(() => null) as { error?: string } | null;
      toast(data?.error ?? `Couldn’t share with @${name}.`);
    }

    if (shared.length > 0) {
      await queryClient.invalidateQueries({ queryKey: ['shares', noteId] });
      await queryClient.invalidateQueries({ queryKey: ['shares', 'summary'] });
      toast(`Shared with ${shared.map(n => `@${n}`).join(', ')} · ${answer.access === 'edit' ? 'can edit' : 'can view'}.`);
    }
  }, [getTitle, noteId, offer, queryClient, secure, toast]);
}
