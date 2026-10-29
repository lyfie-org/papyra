// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { nearestPointIn, placeCaretNear } from './nearestCaret';

const rect = { left: 100, right: 500, top: 200, bottom: 400 };

describe('nearestPointIn', () => {
  it('keeps a point that is already inside', () => {
    expect(nearestPointIn(rect, 250, 300)).toEqual({ x: 250, y: 300 });
  });
  it('pulls a point from the margin, above and below onto the edge', () => {
    expect(nearestPointIn(rect, 20, 300)).toEqual({ x: 101, y: 300 });
    expect(nearestPointIn(rect, 900, 300)).toEqual({ x: 499, y: 300 });
    expect(nearestPointIn(rect, 250, 50)).toEqual({ x: 250, y: 201 });
    expect(nearestPointIn(rect, 250, 800)).toEqual({ x: 250, y: 399 });
    expect(nearestPointIn(rect, 0, 0)).toEqual({ x: 101, y: 201 });
  });
});

describe('placeCaretNear', () => {
  const setup = () => {
    document.body.innerHTML = '<div id="sheet"><button id="b">Lock</button><span id="margin">x</span><div id="ed" contenteditable="true"><p>one line</p></div></div>';
    const ed = document.getElementById('ed') as HTMLElement;
    // jsdom has no layout or contenteditable support: say what the browser would.
    Object.defineProperty(ed, 'isContentEditable', { value: true });
    ed.getBoundingClientRect = () => ({ ...rect, width: 400, height: 200, x: 100, y: 200, toJSON: () => ({}) });
    return ed;
  };

  it('does nothing for a click on a control or inside the writing', () => {
    const ed = setup();
    expect(placeCaretNear(ed, document.getElementById('b'), 10, 10)).toBe(false);
    expect(placeCaretNear(ed, ed.querySelector('p'), 150, 250)).toBe(false);
  });

  it('puts the caret in the writing for a click on the paper beside it', () => {
    const ed = setup();
    expect(placeCaretNear(ed, document.getElementById('margin'), 10, 300)).toBe(true);
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(true);
    expect(ed.contains(selection.anchorNode)).toBe(true);
  });

  it('leaves a click that ended a text selection alone', () => {
    const ed = setup();
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('margin')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    expect(placeCaretNear(ed, document.getElementById('margin'), 10, 300)).toBe(false);
  });
});
