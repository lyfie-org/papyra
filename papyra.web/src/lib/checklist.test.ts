import { describe, expect, it } from 'vitest';
import { openCount, parseChecklist } from './checklist';

// The same body as ChecklistTests.Parse_ReadsItemsInOrder_AtAnyDepth_SkippingFencedCode (C#).
describe('parseChecklist', () => {
  const body = 'Shopping\n\n- [ ] milk\n- [x] bread ^ab12cd34\n  - [ ] oat milk\n* [X] eggs\n\n```\n- [ ] not an item\n```\n\n- [ ]\n- [ ] last';

  it('reads the items in order, at any depth, skipping fenced code and anchors', () => {
    const items = parseChecklist(body);
    expect(items.map((i) => i.text)).toEqual(['milk', 'bread', 'oat milk', 'eggs', 'last']);
    expect(items.map((i) => i.checked)).toEqual([false, true, false, true, false]);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads CRLF files the same', () => {
    expect(parseChecklist('- [ ] a\r\n- [x] b\r\n').map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('is empty for no list', () => {
    expect(parseChecklist('just prose')).toEqual([]);
    expect(parseChecklist(null)).toEqual([]);
    expect(parseChecklist('')).toEqual([]);
  });

  it('counts what is still open', () => {
    expect(openCount(parseChecklist(body))).toBe(3);
  });
});
