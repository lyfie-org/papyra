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
  it('honours the manual key', () => {
    const order: OrderMap = { a: { key: 9_000_000, setAt: 5000 } };
    expect(effectiveKey(note('a', 4000), order)).toBe(9_000_000);
  });
  it('keeps the manual key after the note is edited (a placed note stays put)', () => {
    const order: OrderMap = { a: { key: 9_000_000, setAt: 5000 } };
    expect(effectiveKey(note('a', 6000), order)).toBe(9_000_000);
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

  it('an edit to a note nobody placed floats it above older positions', () => {
    const order: OrderMap = { a: { key: 9_999_999, setAt: 2000 } };
    const ids = sortNotes([note('a', 1000), note('b', 10_000_000)], order).map(n => n.id);
    expect(ids).toEqual(['b', 'a']);
  });

  it('an edit to a placed note does not move it (opening a pinned note must not reorder it)', () => {
    // a placed second of three by hand, then edited (or re-saved) much later.
    const order: OrderMap = {
      top: { key: 3000, setAt: 1 },
      a: { key: 2000, setAt: 1 },
      bottom: { key: 1000, setAt: 1 },
    };
    const ids = sortNotes([note('top', 10), note('a', 99_999_999), note('bottom', 10)], order).map(n => n.id);
    expect(ids).toEqual(['top', 'a', 'bottom']);
  });

  it('a new note goes first', () => {
    const order: OrderMap = { a: { key: 5_000, setAt: 1 } };
    const ids = sortNotes([note('a', 1), note('new', Date.now())], order).map(n => n.id);
    expect(ids[0]).toBe('new');
  });
});
