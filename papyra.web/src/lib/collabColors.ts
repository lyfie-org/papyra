/**
 * Which of the eight `--collab-N` tokens (index.css) a collaborator's caret,
 * name label and selection tint use. Keyed on the username so one person keeps
 * one colour across tabs, notes and sessions — people learn "Bea is the plum
 * one". The value is a `var()` reference, not a hex: awareness carries it to
 * peers, whose own stylesheet resolves it for their theme (and for a coloured
 * note's light paper).
 */
export const COLLAB_COLOR_COUNT = 8;

/** 1..COLLAB_COLOR_COUNT, stable for a given key (FNV-1a). */
export function collabColorIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % COLLAB_COLOR_COUNT) + 1;
}

export function collabColor(key: string): string {
  return `var(--collab-${collabColorIndex(key)})`;
}
