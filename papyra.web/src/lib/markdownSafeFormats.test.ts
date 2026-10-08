import { describe, expect, it } from 'vitest';
import {
  $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, createEditor,
  type LexicalNode, type TextFormatType,
} from 'lexical';
import { jsonToMarkdown, markdownToJSON } from '@lyfie/luthor-headless';
import { registerMarkdownSafeFormats, repairEmphasis } from './markdownSafeFormats';

type Seg = [text: string, ...formats: TextFormatType[]];

/** Text runs of a document as `text|bold,italic` (format names sorted). */
function runs(nodes: LexicalNode[]): string[] {
  const out: string[] = [];
  const walk = (n: LexicalNode) => {
    if ($isTextNode(n)) {
      const f = (['bold', 'italic', 'strikethrough', 'highlight', 'underline', 'code'] as TextFormatType[])
        .filter((x) => n.hasFormat(x)).join(',');
      out.push(f ? `${n.getTextContent()}|${f}` : n.getTextContent());
    } else if ($isElementNode(n)) n.getChildren().forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

function editorWith(segs: Seg[], guarded: boolean) {
  const editor = createEditor({ onError: (e) => { throw e; } });
  if (guarded) registerMarkdownSafeFormats(editor);
  editor.update(() => {
    const p = $createParagraphNode();
    for (const [text, ...formats] of segs) {
      const t = $createTextNode(text);
      for (const f of formats) t.toggleFormat(f);
      p.append(t);
    }
    $getRoot().clear().append(p);
  }, { discrete: true });
  return editor;
}

/** Document → markdown → document, as saving and reopening a note does. */
function roundTrip(segs: Seg[], guarded = true) {
  const editor = editorWith(segs, guarded);
  const shown = editor.getEditorState().read(() => runs($getRoot().getChildren()));
  const markdown = jsonToMarkdown(editor.getEditorState().toJSON());
  const back = createEditor({ onError: (e) => { throw e; } });
  back.setEditorState(back.parseEditorState(JSON.stringify(markdownToJSON(markdown))));
  const reopened = back.getEditorState().read(() => runs($getRoot().getChildren()));
  return { shown, markdown, reopened };
}

describe('registerMarkdownSafeFormats', () => {
  // Each pairs what was pasted with what the editor shows (and saves) instead.
  const cases: [Seg[], string[]][] = [
    [[['Mix:', 'bold'], ['60g atta']], ['Mix|bold', ':60g atta']],
    [[['1.Thursday 2:30 PM: The Initial Mix:', 'bold'], ['60g']], ['1.Thursday 2:30 PM: The Initial Mix|bold', ':60g']],
    [[['1.', 'bold'], ['Thursday']], ['1|bold', '.Thursday']],
    [[['word'], ['(bold)', 'bold'], ['word']], ['word(', 'bold|bold', ')word']],
    [[['gone,', 'strikethrough'], ['x']], ['gone|strikethrough', ',x']],
    [[['italic.', 'italic'], ['next']], ['italic|italic', '.next']],
    [[['mark!', 'highlight'], ['x']], ['mark|highlight', '!x']],
    [[['under:', 'underline'], ['x']], ['under|underline', ':x']],
    [[['both:', 'bold', 'italic'], ['x']], ['both|bold,italic', ':x']],
    [[['Mix ', 'bold'], ['60g']], ['Mix|bold', ' 60g']],
    [[['x'], [' lead', 'bold']], ['x ', 'lead|bold']],
    [[['a'], ['b', 'bold'], ['c']], ['a', 'b|bold', 'c']],
    [[['Mix:', 'bold'], [' 60g']], ['Mix|bold', ': 60g']],
    [[['!!', 'bold'], ['x']], ['!|bold', '!x']],
    [[['!', 'bold'], ['x']], ['!x']],
    [[['Day 1 (Thu):', 'bold'], ['mix']], ['Day 1 (Thu)|bold', ':mix']],
  ];

  it.each(cases)('%j keeps its formatting through save and reopen', (segs, expected) => {
    const { shown, reopened, markdown } = roundTrip(segs);
    expect(shown).toEqual(expected);
    expect(reopened, markdown).toEqual(shown);
  });

  it('reproduces the bug without the guard', () => {
    const { markdown, reopened } = roundTrip([['Mix:', 'bold'], ['60g']], false);
    expect(markdown.split('\n')[0]).toBe('**Mix:**60g');
    expect(reopened).toEqual(['**Mix:**60g']);
  });

  it('leaves well-formed runs and line ends alone', () => {
    for (const segs of [
      [['Mix:', 'bold'], [' 60g']],
      [['ends here:', 'bold']],
      [['(', 'bold'], ['x', 'bold', 'italic']],
    ] as Seg[][]) {
      const { shown, reopened } = roundTrip(segs);
      expect(shown).toEqual(editorWith(segs, false).getEditorState().read(() => runs($getRoot().getChildren())));
      expect(reopened).toEqual(shown);
    }
  });

  it('leaves the run being typed alone (a trailing space at the end of a line)', () => {
    const { shown } = roundTrip([['typing bold ', 'bold']]);
    expect(shown).toEqual(['typing bold |bold']);
  });

  it('never touches inline code', () => {
    const { shown } = roundTrip([['a:', 'bold', 'code'], ['b']]);
    expect(shown).toEqual(['a:|bold,code', 'b']);
  });
});

describe('repairEmphasis', () => {
  const reopen = (md: string) => {
    const e = createEditor({ onError: (err) => { throw err; } });
    e.setEditorState(e.parseEditorState(JSON.stringify(markdownToJSON(md))));
    return e.getEditorState().read(() => runs($getRoot().getChildren()));
  };

  it.each([
    ['**Mix:**60g atta', '**Mix**:60g atta', ['Mix|bold', ':60g atta']],
    ['**1.Thursday 2:30 PM: The Initial Mix:**60g atta', '**1.Thursday 2:30 PM: The Initial Mix**:60g atta', ['1.Thursday 2:30 PM: The Initial Mix|bold', ':60g atta']],
    ['**1.**Thursday', '**1**.Thursday', ['1|bold', '.Thursday']],
    ['word**(bold)**word', 'word(**bold**)word', ['word(', 'bold|bold', ')word']],
    ['~~gone,~~x', '~~gone~~,x', ['gone|strikethrough', ',x']],
    ['*italic.*next', '*italic*.next', ['italic|italic', '.next']],
    ['***both:***x', '***both***:x', ['both|bold,italic', ':x']],
    ['==mark!==x', '==mark==!x', ['mark|highlight', '!x']],
    ['**!!**x', '**!**!x', ['!|bold', '!x']],
    ['**!**x', '!x', ['!x']],
    ['**Day 1 (Thu):**mix', '**Day 1 (Thu)**:mix', ['Day 1 (Thu)|bold', ':mix']],
  ])('%s → %s', (input, repaired, shown) => {
    expect(repairEmphasis(input)).toBe(repaired);
    expect(reopen(repaired)).toEqual(shown);
  });

  it.each([
    '**Mix:** 60g',
    'a**b**c',
    '2*3*4',
    'a*(b)*c',
    '\\*\\*Mix:\\*\\*60g',
    'use `**Mix:**60g` literally',
    '** spaced **x',
    'plain text, no markers',
    '- **Item:** detail\n1. **Step**: two',
  ])('leaves %j unchanged', (input) => {
    expect(repairEmphasis(input)).toBe(input);
  });

  it('skips fenced code', () => {
    const md = 'before **a:**b\n```\n**a:**b\n```\nafter **c:**d';
    expect(repairEmphasis(md)).toBe('before **a**:b\n```\n**a:**b\n```\nafter **c**:d');
  });

  it('repairs a whole pasted recipe line by line', () => {
    const md = [
      '**1.Thursday 2:30 PM: The Initial Mix:**60g atta + 60g water.',
      'Put your jar on the scale and zero it.',
      '**2.Friday 2:30 PM: The Observation Rest:**Do absolutely nothing.',
    ].join('\n');
    expect(repairEmphasis(md)).toBe([
      '**1.Thursday 2:30 PM: The Initial Mix**:60g atta + 60g water.',
      'Put your jar on the scale and zero it.',
      '**2.Friday 2:30 PM: The Observation Rest**:Do absolutely nothing.',
    ].join('\n'));
  });
});
