import { describe, expect, it } from 'vitest';
import { countWords } from './journalText';

// The same cases as JournalCoreTests.WordCount_IgnoresEmbedsAndLinks (C#).
describe('countWords', () => {
  it.each([
    ['', 0],
    ['Walked home.', 2],
    ['It\'s a well-known thing — really', 5],
    ['![[photo.png]] a picture https://example.com/x here', 3],
    ['日本語 text', 4],
    ['   \n  ', 0],
  ])('%j → %i', (text, n) => expect(countWords(text)).toBe(n));

  it('does not count block anchors', () => {
    expect(countWords('A paragraph ^a1b2c3d4')).toBe(2);
  });
});

import { openItemCount } from './journalText';

describe('openItemCount', () => {
  it('counts unticked items only, at any depth', () => {
    expect(openItemCount('- [ ] a\n- [x] b\n  - [ ] c\n* [ ] d\n- [ ]\ntext - [ ] not an item')).toBe(3);
    expect(openItemCount('')).toBe(0);
  });
});
