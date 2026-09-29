// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildTextIndex, findQuote, quoteFromRange, rangeForQuote } from './textAnchor';

function editor(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('text quote anchoring', () => {
  it('round-trips a selection across inline formatting', () => {
    const root = editor('<p>Ship the <strong>beta</strong> on Friday.</p><p>Then rest.</p>');
    const index = buildTextIndex(root);
    expect(index.text).toBe('Ship the beta on Friday.\nThen rest.');

    const range = document.createRange();
    const strong = root.querySelector('strong')!.firstChild!;
    range.setStart(strong, 0);
    range.setEnd(root.querySelector('p')!.lastChild!, 4); // " on " → through "on "
    const quote = quoteFromRange(index, range)!;
    expect(quote.exact).toBe('beta on');
    expect(quote.prefix).toBe('Ship the ');

    const found = rangeForQuote(buildTextIndex(root), quote)!;
    expect(found.toString()).toBe('beta on');
  });

  it('picks the occurrence whose context matches', () => {
    const text = 'todo: fix it. done: fix it. todo: fix it again';
    const second = findQuote(text, { exact: 'fix it', prefix: 'done: ', suffix: '. todo' });
    expect(second?.start).toBe(text.indexOf('done: fix it') + 'done: '.length);
  });

  it('detaches when the passage is edited away', () => {
    const root = editor('<p>Ship the beta on Friday.</p>');
    expect(rangeForQuote(buildTextIndex(root), { exact: 'on Monday', prefix: '', suffix: '' })).toBeNull();
  });

  it('finds a quote again after edits elsewhere in the note', () => {
    const root = editor('<p>Intro</p><p>Ship the beta on Friday.</p>');
    const quote = { exact: 'on Friday', prefix: 'Ship the beta ', suffix: '.' };
    root.querySelector('p')!.textContent = 'A much longer introduction than before';
    expect(rangeForQuote(buildTextIndex(root), quote)?.toString()).toBe('on Friday');
  });

  it('trims whitespace a selection dragged along', () => {
    const root = editor('<p>one two three</p>');
    const t = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(t, 3);
    range.setEnd(t, 8);
    expect(quoteFromRange(buildTextIndex(root), range)?.exact).toBe('two');
  });
});
