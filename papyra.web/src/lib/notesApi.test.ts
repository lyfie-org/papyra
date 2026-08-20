import { describe, expect, it } from 'vitest';
import { mergeQueued } from './notesApi';
import type { Note } from '../types/note';
import type { OutboxEntry } from './outbox';

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'a', title: 'A', tags: [], color: null, pinned: false, archived: false,
    kind: 'note', trashed: false, updated: '2026-01-01T00:00:00Z', body: 'server body',
    ...over,
  };
}

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'a',
    queuedAt: '2026-02-02T00:00:00Z',
    payload: {
      title: 'A (edited offline)', tags: ['t'], color: null, pinned: false,
      archived: false, kind: 'note', body: 'offline body',
    },
    ...over,
  };
}

describe('mergeQueued', () => {
  it('leaves the server snapshot alone when nothing is queued', () => {
    const notes = [note()];
    expect(mergeQueued(notes, [])).toBe(notes);
  });

  it('overlays a queued edit on the matching note', () => {
    const merged = mergeQueued([note()], [entry()]);
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('offline body');
    expect(merged[0].title).toBe('A (edited offline)');
    expect(merged[0].tags).toEqual(['t']);
  });

  it('stamps the merged note with the queue time so recency sorting is right', () => {
    const merged = mergeQueued([note()], [entry()]);
    expect(merged[0].updated).toBe('2026-02-02T00:00:00Z');
  });

  it('surfaces a note created while offline that the server has never seen', () => {
    const merged = mergeQueued([note()], [entry({ id: 'brand-new' })]);
    expect(merged.map((n) => n.id).sort()).toEqual(['a', 'brand-new']);
    expect(merged.find((n) => n.id === 'brand-new')?.body).toBe('offline body');
  });

  it('keeps server-only fields the outbox payload does not carry', () => {
    const merged = mergeQueued([note({ secure: true, trashed: true })], [entry()]);
    expect(merged[0].secure).toBe(true);
    expect(merged[0].trashed).toBe(true);
  });

  it('never lets a queued payload change the note id', () => {
    const merged = mergeQueued([note()], [entry({ id: 'a' })]);
    expect(merged[0].id).toBe('a');
  });
});
