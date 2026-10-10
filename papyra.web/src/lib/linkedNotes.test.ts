import { describe, expect, it } from 'vitest';
import type { Note } from '../types/note';
import { linkedNotes, linkTargets } from './linkedNotes';

const note = (id: string, title: string, extra: Partial<Note> = {}): Note => ({
  id, title, body: '', tags: [], color: null, pinned: false, archived: false, trashed: false,
  kind: 'note', created: '', updated: '', ...extra,
} as Note);

describe('linkTargets', () => {
  it('finds each linked note once, by the name used, without heading or alias', () => {
    const body = [
      'See [[Packing list]] and [[Budget|money]], then [[packing list#Shoes]].',
      'Quote: ![[Itinerary#^day1]]',
      'Not notes: ![[photo.png]] ![[youtube:https://youtu.be/x]] ![[card:https://a.b]] [[report.pdf]]',
      '`[[In code]]`',
      '```',
      '[[Fenced]]',
      '```',
    ].join('\n');
    expect(linkTargets(body)).toEqual(['Packing list', 'Budget', 'Itinerary']);
  });
});

describe('linkedNotes', () => {
  it('resolves by title then id, and leaves out itself, trashed and locked notes', () => {
    const notes = [
      note('n1', 'Trip plan'),
      note('n2', 'Packing list'),
      note('budget-2026', 'Money'),
      note('n4', 'Old', { trashed: true }),
      note('n5', 'Secret', { secure: true }),
    ];
    const self = { id: 'n1', body: '[[packing LIST]] [[budget-2026]] [[Old]] [[Secret]] [[Trip plan]] [[Nowhere]]' };
    expect(linkedNotes(self, notes).map((n) => n.id)).toEqual(['n2', 'budget-2026']);
  });
});
