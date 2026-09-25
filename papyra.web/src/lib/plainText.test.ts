import { describe, expect, it } from 'vitest';
import { flattenMarkdown, normaliseLines, stripBlockAnchors } from './plainText';

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

  it('strips nested and empty list markers, never leaving a stray "3."', () => {
    const md = ['1. Whiskey ^w1', '    1. Yamazaki ^y1', '    2. Hibiki', '    3. ^0b9vdhib', '    4.', '- [ ]', '#'].join('\n');
    expect(normaliseLines(flattenMarkdown(md))).toBe('Whiskey\nYamazaki\nHibiki');
  });

  it('handles CRLF files the same as LF', () => {
    expect(normaliseLines(flattenMarkdown('1. A\r\n    2.\r\n- [x]\r\n# \r\nB'))).toBe('A\nB');
  });

  it('leaves numbers and hashtags in prose alone', () => {
    expect(flattenMarkdown('1.5 kg rice #tag')).toBe('1.5 kg rice #tag');
  });
});
