// The "modified externally" banner's Review: show the revision another program
// wrote, in place of the person's unsaved draft. Adopting it remounts the editor
// on that text, so the draft would be gone — from the editor, the disk and
// History alike. It is kept as a History version first, and nothing is adopted
// unless that worked.

export interface Revision { title: string; body: string }

export type ReviewOutcome =
  /** Adopted; the draft is in History as `kept` (null: nothing needed keeping). */
  | { adopted: true; kept: string | null }
  /**
   * Nothing adopted; the editor is untouched. `failed`: the draft could not be
   * kept. `resolved`: the revision stopped being pending meanwhile (a save
   * overwrote it), so there is nothing left to show.
   */
  | { adopted: false; reason: 'failed' | 'resolved' };

const same = (a: Revision, b: Revision) => a.title === b.title && a.body === b.body;

// Bounded so a stream of keystrokes can't hold Review open forever; each round
// is one request, and typing that outruns three of them is not realistic.
const MAX_ROUNDS = 3;

export async function reviewRevision(opts: {
  /** The live draft, read fresh each time (the person may type meanwhile). */
  getDraft: () => Revision;
  /** The revision Review adopts, read when adopting; null once no longer pending. */
  getIncoming: () => Revision | null;
  keep: (draft: Revision) => Promise<string | null>;
  adopt: (next: Revision) => void;
}): Promise<ReviewOutcome> {
  let kept: string | null = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const incoming = opts.getIncoming();
    if (!incoming) return { adopted: false, reason: 'resolved' };
    const draft = opts.getDraft();
    // Already what is on disk: adopting loses nothing.
    if (same(draft, incoming)) break;
    try {
      kept = await opts.keep(draft);
    } catch {
      return { adopted: false, reason: 'failed' };
    }
    // Typed while it was being kept: keep the newer draft too.
    if (same(opts.getDraft(), draft)) break;
  }
  const incoming = opts.getIncoming();
  if (!incoming) return { adopted: false, reason: 'resolved' };
  opts.adopt(incoming);
  return { adopted: true, kept };
}
