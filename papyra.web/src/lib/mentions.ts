/**
 * `@username` detection, mirroring `MentionDeliveryService.Mentions` on the
 * server (`Storage/MentionDeliveryService.cs`).
 *
 * The server stays the authority on *delivery* — it detects mentions on the
 * notes PUT, which is also reachable from API keys and share links, so a
 * client-side check could never be the gate. This copy exists for one job: the
 * moment after a save, work out which names are new so the editor can offer to
 * share the note with them. Offering is the client's business, because sharing
 * has to be a decision somebody makes, not something that happens to them.
 */

// `@name` as a standalone token: not mid-word, not part of an email address.
const MENTION = /(?<=^|[\s([])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\b/g;

/** Distinct usernames mentioned in a body, lower-cased, in first-seen order. */
export function mentionsIn(body: string | null | undefined): string[] {
  if (!body) return [];
  const seen: string[] = [];
  for (const match of body.matchAll(MENTION)) {
    // Trailing punctuation belongs to the sentence, not the name: "@bea." is bea.
    const name = match[1].replace(/[._-]+$/, '');
    if (!name) continue;
    if (!seen.some(s => s.toLowerCase() === name.toLowerCase())) seen.push(name);
  }
  return seen;
}

/** Names present in `next` that were not in `prior` — the ones just typed. */
export function newMentions(prior: string | null | undefined, next: string | null | undefined): string[] {
  const before = new Set(mentionsIn(prior).map(m => m.toLowerCase()));
  return mentionsIn(next).filter(m => !before.has(m.toLowerCase()));
}
