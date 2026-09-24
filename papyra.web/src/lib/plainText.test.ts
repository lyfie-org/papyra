import { describe, expect, it } from 'vitest';
import { flattenMarkdown, stripBlockAnchors } from './plainText';

describe('stripBlockAnchors', () => {
  it('drops the trailing anchor from every kind of line', () => {
    const md = [
      'Things to buy: ^xkncpelm',
      '',
      '1. Ramen Bowl Set (Bowl, Spoon, Etc.) ^13fphj82',
      '    1. Sometsuke ^mpjbd9gz',
      '- Sake ^fvapwi6k',
    ].join('\n');
    expect(stripBlockAnchors(md)).toBe([
      'Things to buy:',
      '',
      '1. Ramen Bowl Set (Bowl, Spoon, Etc.)',
      '    1. Sometsuke',
      '- Sake',
    ].join('\n'));
  });

  it('drops a run of stacked anchors', () => {
    expect(stripBlockAnchors('3. Things to buy: ^mplx3v51 ^os03fxm0')).toBe('3. Things to buy:');
  });

  it('leaves a caret that is part of the prose alone', () => {
    expect(stripBlockAnchors('x ^2 later')).toBe('x ^2 later');
    expect(stripBlockAnchors('2^10 is 1024')).toBe('2^10 is 1024');
  });
});

describe('flattenMarkdown', () => {
  it('keeps the text of a strikethrough', () => {
    expect(flattenMarkdown('~~gone~~ kept')).toBe('gone kept');
  });
});
