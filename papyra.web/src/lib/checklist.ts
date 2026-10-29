// A to-do's checklist, read the way the server reads it (`Storage/Checklist.cs`) —
// same items, same order, same indices — so a tick names an item both sides agree on.

export interface ChecklistItem {
  /** Place among the list's items; with `text`, how the server finds the item. */
  index: number;
  text: string;
  checked: boolean;
}

/** The block id that means "this note's whole checklist" in `![[Title#^checklist]]`. */
export const CHECKLIST_BLOCK = 'checklist';

const ITEM = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(\S.*?)[ \t]*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// A trailing ` ^id` block anchor is the editor's, not the person's text.
const ANCHOR = /(?<=^|[ \t])\^[A-Za-z0-9][A-Za-z0-9_-]*(?=[ \t]|$)/g;

export function parseChecklist(markdown: string | null | undefined): ChecklistItem[] {
  if (!markdown) return [];
  const items: ChecklistItem[] = [];
  let open: string | null = null;
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const fence = FENCE.exec(raw);
    if (fence) {
      const marker = fence[1];
      if (open === null) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length) open = null;
      continue;
    }
    if (open !== null) continue;
    const m = ITEM.exec(raw);
    if (!m) continue;
    items.push({
      index: items.length,
      text: m[2].replace(ANCHOR, '').replace(/[ \t]{2,}/g, ' ').trim(),
      checked: m[1] !== ' ',
    });
  }
  return items;
}

export function openCount(items: readonly ChecklistItem[]): number {
  return items.reduce((n, i) => n + (i.checked ? 0 : 1), 0);
}
