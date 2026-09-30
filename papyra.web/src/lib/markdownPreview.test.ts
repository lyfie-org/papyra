import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, previewCapEm, stripComments, type ListBlock } from './markdownPreview';

describe('parseBlocks', () => {
  it('nests an editor-written numbered list and drops block anchors', () => {
    const md = [
      'Things to buy: ^xkncpelm',
      '',
      '1. Ramen Bowl Set ^13fphj82',
      '    1. Sometsuke ^mpjbd9gz',
      '    2. Mino-yaki ^klfj1pn3',
      '2. Sake ^fvapwi6k',
    ].join('\n');
    const { blocks, truncated } = parseBlocks(md);
    expect(truncated).toBe(false);
    expect(blocks[0]).toEqual({ t: 'p', lines: [[{ t: 'text', v: 'Things to buy:' }]] });
    const list = blocks[1] as ListBlock;
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.content)).toEqual([[{ t: 'text', v: 'Ramen Bowl Set' }], [{ t: 'text', v: 'Sake' }]]);
    const child = list.items[0].children!;
    expect(child.depth).toBe(1);
    expect(child.items).toHaveLength(2);
  });

  it('nests three levels of bullets and returns to the right level', () => {
    const md = ['- a', '    - b', '        - c', '    - d', '- e'].join('\n');
    const list = parseBlocks(md).blocks[0] as ListBlock;
    expect(list.items).toHaveLength(2);
    const b = list.items[0].children!;
    expect(b.items.map((i) => i.content[0])).toEqual([{ t: 'text', v: 'b' }, { t: 'text', v: 'd' }]);
    expect(b.items[0].children!.depth).toBe(2);
  });

  it('reads task items and headings', () => {
    const { blocks } = parseBlocks('# Plan\n- [x] done\n- [ ] todo');
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    const list = blocks[1] as ListBlock;
    expect(list.items.map((i) => i.task)).toEqual([true, false]);
  });

  it('splits bullets and numbers at the top level into separate lists', () => {
    const { blocks } = parseBlocks('- one\n1. two');
    expect(blocks.map((b) => (b as ListBlock).ordered)).toEqual([false, true]);
  });

  it('reads an empty item — with or without its trailing space — as an item, not text', () => {
    // The shape that used to drift on save: a new empty sub-item under "Whiskey".
    for (const empty of ['    3. ', '    3.', '    3. ^0b9vdhib']) {
      const md = ['1. Whiskey ^w1', '    1. Yamazaki ^y1', '    2. Hibiki ^h1', empty].join('\n');
      const list = parseBlocks(md).blocks[0] as ListBlock;
      expect(list.items).toHaveLength(1);
      const sub = list.items[0].children!;
      expect(sub.items).toHaveLength(3);
      expect(sub.items[2].content).toEqual([]);
    }
  });

  it('reads empty task items and headings', () => {
    const { blocks } = parseBlocks('#\n- [ ]\n- [x] done');
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1, c: [] });
    const list = blocks[1] as ListBlock;
    expect(list.items.map((i) => i.task)).toEqual([false, true]);
  });

  it('does not mistake numbers, hashtags or rules for markers', () => {
    const { blocks } = parseBlocks('1.5 kg rice\n#tag\n\n---');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'hr']);
  });

  it('stops after the line budget and reports truncation', () => {
    const md = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const { blocks, truncated } = parseBlocks(md, 5);
    expect(truncated).toBe(true);
    expect((blocks[0] as { lines: unknown[] }).lines).toHaveLength(5);
  });
});

describe('parseInline', () => {
  it('parses emphasis, code and links without HTML', () => {
    expect(parseInline('a **b** *c* ~~d~~ `e` [[Note|f]] <b>x</b>')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'e' },
      { t: 'text', v: ' ' },
      { t: 'link', c: [{ t: 'text', v: 'f' }] },
      { t: 'text', v: ' <b>x</b>' },
    ]);
  });

  it('leaves snake_case words alone', () => {
    expect(parseInline('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }]);
  });
});

describe('previewCapEm', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('shows short notes whole', () => {
    expect(previewCapEm('')).toBeNull();
    expect(previewCapEm(lines(8))).toBeNull();
    // A line or two past ten is not worth a fade.
    expect(previewCapEm(lines(11))).toBeNull();
  });

  it('lets longer notes grow with their length, not stop at one height', () => {
    const a = previewCapEm(lines(16))!;
    const b = previewCapEm(lines(24))!;
    const c = previewCapEm(lines(32))!;
    expect(a).toBeGreaterThan(16);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // …but slower than the content does.
    expect(b - a).toBeLessThan(8 * 1.55);
  });

  it('keeps long notes apart instead of flattening them to one height', () => {
    const forty = previewCapEm(lines(40))!;
    const eighty = previewCapEm(lines(80))!;
    expect(eighty).toBeGreaterThan(forty + 1);
  });

  it('stops the very longest at a ceiling', () => {
    expect(previewCapEm(lines(200))).toBe(previewCapEm(lines(400)));
    expect(previewCapEm(lines(200))).toBeLessThanOrEqual(48);
  });

  it('counts wrapped prose, not just line breaks', () => {
    const paragraph = 'word '.repeat(150); // one source line, many card lines
    expect(previewCapEm(paragraph)).not.toBeNull();
  });

  it('ignores block anchors and list markers', () => {
    expect(previewCapEm('- [ ] buy milk ^abc12345')).toBeNull();
  });
});

describe('editor metadata comments', () => {
  it('never shows an attachment directive as text', () => {
    const { blocks } = parseBlocks('Click the picture:\n\n![[a.png|300]] <!-- align:right -->\n<!-- caption:Hi -->\n\nAfter');
    expect(JSON.stringify(blocks)).not.toContain('align');
    expect(JSON.stringify(blocks)).not.toContain('caption');
    expect(JSON.stringify(blocks)).toContain('After');
  });

  it('keeps comments written inside code', () => {
    expect(stripComments('```html\n<!-- keep -->\n```\nx <!-- drop -->')).toBe('```html\n<!-- keep -->\n```\nx');
  });
});
