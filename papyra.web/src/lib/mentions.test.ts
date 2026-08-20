import { describe, it, expect } from 'vitest';
import { mentionsIn, newMentions } from './mentions';

// This is a copy of a server-side rule (MentionDeliveryService.Mentions), so
// what these tests really pin down is the shape of that agreement: the same text
// has to produce the same names on both sides, or the editor offers to share
// with someone the server never delivered to.
describe('mentionsIn', () => {
  it('finds a name at the start, mid-sentence, and in brackets', () => {
    expect(mentionsIn('@bea can you look')).toEqual(['bea']);
    expect(mentionsIn('ask @bea about it')).toEqual(['bea']);
    expect(mentionsIn('(@bea) and [@cleo]')).toEqual(['bea', 'cleo']);
  });

  it('ignores an @ that is part of a word or an address', () => {
    expect(mentionsIn('bea@example.com')).toEqual([]);
    expect(mentionsIn('user@host said hi')).toEqual([]);
    expect(mentionsIn('email me at me@you.net')).toEqual([]);
  });

  it('drops trailing punctuation from the name', () => {
    expect(mentionsIn('thanks @bea.')).toEqual(['bea']);
    expect(mentionsIn('@bea, @cleo-')).toEqual(['bea', 'cleo']);
  });

  it('keeps dots and dashes inside a username', () => {
    expect(mentionsIn('@bea.smith and @cleo-jones')).toEqual(['bea.smith', 'cleo-jones']);
  });

  it('lists each name once, in the order they first appear', () => {
    expect(mentionsIn('@cleo @bea @cleo again')).toEqual(['cleo', 'bea']);
  });

  it('treats a repeat in different case as the same person', () => {
    expect(mentionsIn('@Bea and @bea')).toEqual(['Bea']);
  });

  it('handles an empty body', () => {
    expect(mentionsIn('')).toEqual([]);
    expect(mentionsIn(null)).toEqual([]);
    expect(mentionsIn(undefined)).toEqual([]);
  });
});

describe('newMentions', () => {
  it('reports only the names this revision added', () => {
    expect(newMentions('hello @bea', 'hello @bea and @cleo')).toEqual(['cleo']);
  });

  it('reports nothing when a note is re-saved unchanged', () => {
    expect(newMentions('hello @bea', 'hello @bea')).toEqual([]);
  });

  it('does not re-report a name whose case changed', () => {
    expect(newMentions('hi @bea', 'hi @Bea')).toEqual([]);
  });

  it('reports everything when there was no prior revision', () => {
    expect(newMentions('', '@bea and @cleo')).toEqual(['bea', 'cleo']);
  });

  it('reports nothing when a name is removed', () => {
    expect(newMentions('@bea @cleo', '@bea')).toEqual([]);
  });
});
