import { describe, it, expect } from 'vitest';
import { decodeReferences, finishCode, finishText, protectEscapes, restoreEscapes } from './markdownText';
import { parseBlocks } from './markdownPreview';
import { flattenMarkdown, snippet } from './plainText';

// What the editor writes for text that would otherwise read as syntax must
// show on a card and in a snippet exactly as the person typed it.

describe('markdownText helpers', () => {
  it('protects and restores backslash escapes', () => {
    const p = protectEscapes(String.raw`a \* b \_ c \# d \\ e`);
    expect(p).not.toContain('*');
    expect(restoreEscapes(p)).toBe(String.raw`a * b _ c # d \ e`);
    expect(restoreEscapes(p, true)).toBe(String.raw`a \* b \_ c \# d \\ e`);
  });

  it('leaves a backslash before a letter or at the end alone', () => {
    expect(protectEscapes(String.raw`C:\path\to\ `)).toBe(String.raw`C:\path\to\ `);
    expect(protectEscapes('end\\')).toBe('end\\');
  });

  it('decodes decimal and hex references and drops the empty-line marker', () => {
    expect(decodeReferences('&#35; &#x23; &#91; &#38;#35; x&#8203;y')).toBe('# # [ &#35; xy');
  });

  it('leaves invalid or named references as written', () => {
    expect(decodeReferences('&#0; &#55296; &#9999999; &amp; &copy;')).toBe('&#0; &#55296; &#9999999; &amp; &copy;');
  });

  it('finishes prose and code differently', () => {
    const p = protectEscapes(String.raw`\*`);
    expect(finishText(`${p}&#35;`)).toBe('*#');
    expect(finishCode(`${p}&#35;`)).toBe(String.raw`\*&#35;`);
  });
});

describe('card preview', () => {
  const texts = (md: string) => JSON.stringify(parseBlocks(md).blocks);

  it('shows literal syntax as text, never as a list, heading or quote', () => {
    const { blocks } = parseBlocks('&#35; not a heading\n\n1&#46; not a list\n\n&#62; not a quote');
    expect(blocks.every((b) => b.t === 'p')).toBe(true);
    expect(texts('&#35; not a heading')).toContain('# not a heading');
    expect(texts('1&#46; not a list')).toContain('1. not a list');
  });

  it('shows escaped stars as stars, not italics', () => {
    const { blocks } = parseBlocks(String.raw`a \*b\* c`);
    expect(JSON.stringify(blocks)).not.toContain('"em"');
    expect(JSON.stringify(blocks)).toContain('a *b* c');
  });

  it('reads a code span holding a backtick', () => {
    const { blocks } = parseBlocks('use `` a`b `` here');
    expect(JSON.stringify(blocks)).toContain('{"t":"code","v":"a`b"}');
  });

  it('keeps a code block exactly as written', () => {
    const { blocks } = parseBlocks('```\n\\* &#35;\n```');
    expect(blocks[0]).toEqual({ t: 'code', v: '\\* &#35;' });
  });

  it('a literal link stays text', () => {
    expect(JSON.stringify(parseBlocks('see &#91;x](y)').blocks)).toContain('see [x](y)');
    expect(JSON.stringify(parseBlocks('see &#91;x](y)').blocks)).not.toContain('"link"');
  });
});

describe('plain text', () => {
  it('flattens with escapes and references resolved', () => {
    expect(flattenMarkdown(String.raw`&#35; tag \*not bold\* and &#91;x](y)`)).toBe('# tag *not bold* and [x](y)');
  });

  it('an empty line inside a paragraph leaves no trace in a snippet', () => {
    expect(snippet('one\n&#8203;\nthree')).toBe('one\nthree');
  });

  it('extra blank lines never show as gaps in a snippet', () => {
    expect(snippet('a\n\n\n\nb')).toBe('a\nb');
  });
});
