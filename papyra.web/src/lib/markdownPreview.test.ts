import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, type ListBlock } from './markdownPreview';

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
