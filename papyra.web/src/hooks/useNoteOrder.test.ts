import { describe, it, expect } from 'vitest';
import { effectiveKey, sortNotes, keyBetween, ORDER_STEP, type OrderMap } from './useNoteOrder';
import type { Note } from '../types/note';

function note(id: string, updatedMs: number): Note {
  return {
    id, title: id, tags: [], color: null, pinned: false, archived: false,
    trashed: false, kind: 'note', updated: new Date(updatedMs).toISOString(), body: '',
  };
}

describe('keyBetween', () => {
  it('midpoints between two neighbours', () => {
    expect(keyBetween(100, 200)).toBe(150);
  });
  it('sits above the top neighbour', () => {
    expect(keyBetween(null, 200)).toBe(200 + ORDER_STEP);
  });
  it('sits below the bottom neighbour', () => {
    expect(keyBetween(100, null)).toBe(100 - ORDER_STEP);
  });
  it('falls back to now when the section is empty', () => {
    const before = Date.now();
    const k = keyBetween(null, null);
    expect(k).toBeGreaterThanOrEqual(before);
  });
});

describe('effectiveKey', () => {
  it('uses last-modified when there is no manual entry', () => {
    expect(effectiveKey(note('a', 1000), {})).toBe(1000);
  });
  it('honours the manual key while the note has not been edited since the drag', () => {
    const order: OrderMap = { a: { key: 9_000_000, setAt: 5000 } };
    expect(effectiveKey(note('a', 4000), order)).toBe(9_000_000); // updated(4000) <= setAt(5000)
  });
  it('discards a stale manual key once the note is edited again', () => {
    const order: OrderMap = { a: { key: 9_000_000, setAt: 5000 } };
    expect(effectiveKey(note('a', 6000), order)).toBe(6000); // updated(6000) > setAt(5000)
  });
});

describe('sortNotes', () => {
  it('defaults to most-recently-modified first', () => {
    const ids = sortNotes([note('old', 1000), note('new', 2000)], {}).map(n => n.id);
    expect(ids).toEqual(['new', 'old']);
  });

  it('keeps a dragged note above a recency that is older than its drag', () => {
    const order: OrderMap = { a: { key: 9_999_999, setAt: 2000 } };
    const ids = sortNotes([note('a', 1000), note('b', 5000)], order).map(n => n.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('an edit bumps a note above any manual drag position', () => {
    // a was dragged to the top; then b is edited (updated newer than a's drag) →
    // b must overtake a.
    const order: OrderMap = { a: { key: 9_999_999, setAt: 2000 } };
    const ids = sortNotes([note('a', 1000), note('b', 10_000_000)], order).map(n => n.id);
    expect(ids).toEqual(['b', 'a']);
  });
});
