// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { needsDescription, parseKeys, place, resolveTip, showDelay, splitShortcut, SHOW_DELAY_MS } from './tooltip';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('splitShortcut', () => {
  it('takes a trailing shortcut apart into keys', () => {
    expect(splitShortcut('Bold (Ctrl+B)')).toEqual({ text: 'Bold', keys: ['Ctrl', 'B'] });
    expect(splitShortcut('Previous day (Alt+Shift+←)')).toEqual({ text: 'Previous day', keys: ['Alt', 'Shift', '←'] });
    expect(splitShortcut('Close (Esc)')).toEqual({ text: 'Close', keys: ['Esc'] });
    expect(splitShortcut('Close the vault (⌘/Ctrl+Shift+L)')).toEqual({ text: 'Close the vault', keys: ['⌘/Ctrl', 'Shift', 'L'] });
  });
  it('leaves any other parenthesis alone', () => {
    expect(splitShortcut('Share (everyone sees it)')).toEqual({ text: 'Share (everyone sees it)', keys: [] });
    expect(splitShortcut('Change colour (everyone with this note sees it)').keys).toEqual([]);
    expect(splitShortcut('(Ctrl+B)')).toEqual({ text: '(Ctrl+B)', keys: [] });        // nothing before it
  });
  it('keeps line breaks and trims', () => {
    expect(splitShortcut('  Q3 report\nPDF document · 1.2 MB ').text).toBe('Q3 report\nPDF document · 1.2 MB');
  });
});

describe('parseKeys', () => {
  it('splits on +', () => expect(parseKeys('Ctrl + Alt+M')).toEqual(['Ctrl', 'Alt', 'M']));
  it('is empty for nothing', () => expect(parseKeys('')).toEqual([]));
});

describe('resolveTip', () => {
  it('prefers data-tooltip, with its keys', () => {
    const root = dom('<button id="a" data-tooltip="Next day" data-tooltip-keys="Alt+Shift+→" title="ignored" aria-label="Next day">→</button>');
    const r = resolveTip(root.querySelector('#a'))!;
    expect(r.source).toBe('attribute');
    expect(r.content).toEqual({ text: 'Next day', keys: ['Alt', 'Shift', '→'] });
  });

  it('lifts a plain title, shortcut and all (the editor toolbar sets these)', () => {
    const root = dom('<button id="a" title="Bold (Ctrl+B)"><svg></svg></button>');
    const r = resolveTip(root.querySelector('#a'))!;
    expect(r.source).toBe('title');
    expect(r.content).toEqual({ text: 'Bold', keys: ['Ctrl', 'B'] });
  });

  it('lends an icon-only control its aria-label', () => {
    const root = dom('<button id="a" aria-label="Notifications"><svg></svg></button>');
    const r = resolveTip(root.querySelector('#a'))!;
    expect(r.source).toBe('label');
    expect(r.content.text).toBe('Notifications');
  });

  it('gives nothing to a control that already shows its label', () => {
    const root = dom('<button id="a" aria-label="Today">Today</button>');
    expect(resolveTip(root.querySelector('#a'))).toBeNull();
  });

  it('gives nothing to plain text, or to an iframe’s name', () => {
    const root = dom('<p id="p">Hello</p><iframe id="f" title="Q3 report"></iframe>');
    expect(resolveTip(root.querySelector('#p'))).toBeNull();
    expect(resolveTip(root.querySelector('#f'))).toBeNull();
  });

  it('looks outward from the element, nearest first, as the browser does', () => {
    const root = dom('<div id="outer" data-tooltip="Card"><button id="in"><span id="icon"></span></button><button id="named" data-tooltip="Delete">x</button></div>');
    expect(resolveTip(root.querySelector('#icon'))!.host.id).toBe('outer');      // the button has none: the card's applies
    expect(resolveTip(root.querySelector('#named span') ?? root.querySelector('#named'))!.content.text).toBe('Delete');
  });

  it('works from a child of the control (an icon inside a button)', () => {
    const root = dom('<button id="b" data-tooltip="Share"><svg id="s"></svg></button>');
    expect(resolveTip(root.querySelector('#s'))!.host.id).toBe('b');
  });

  it('ignores an empty attribute and null', () => {
    const root = dom('<button id="a" data-tooltip="  ">x</button>');
    expect(resolveTip(root.querySelector('#a'))).toBeNull();
    expect(resolveTip(null)).toBeNull();
  });
});

describe('needsDescription', () => {
  it('is false when the tooltip only repeats the name', () => {
    const root = dom('<button id="a" aria-label="Close preview">x</button><button id="b">Select all</button><button id="c" aria-label="Share note">x</button>');
    expect(needsDescription(root.querySelector('#a')!, 'close preview')).toBe(false);
    expect(needsDescription(root.querySelector('#b')!, 'Select all')).toBe(false);
    expect(needsDescription(root.querySelector('#c')!, 'Share with someone else')).toBe(true);
  });
});

describe('place', () => {
  const view = { width: 1000, height: 700 };
  const tip = { width: 120, height: 30 };

  it('sits centred below the control', () => {
    expect(place({ x: 400, y: 100, width: 40, height: 40 }, tip, view)).toEqual({ x: 360, y: 148, side: 'bottom' });
  });
  it('goes above when there is no room below', () => {
    const p = place({ x: 400, y: 660, width: 40, height: 30 }, tip, view);
    expect(p.side).toBe('top');
    expect(p.y).toBe(660 - 8 - 30);
  });
  it('stays inside the window at either edge', () => {
    expect(place({ x: 0, y: 100, width: 20, height: 20 }, tip, view).x).toBe(8);
    expect(place({ x: 990, y: 100, width: 10, height: 20 }, tip, view).x).toBe(1000 - 120 - 8);
  });
  it('takes the roomier side when neither fits', () => {
    const tall = { width: 100, height: 400 };
    const small = { width: 500, height: 500 };
    expect(place({ x: 10, y: 100, width: 10, height: 10 }, tall, small).side).toBe('bottom');
    expect(place({ x: 10, y: 380, width: 10, height: 10 }, tall, small).side).toBe('top');
  });
  it('never goes above the top of the window', () => {
    expect(place({ x: 10, y: 5, width: 10, height: 10 }, { width: 100, height: 900 }, { width: 500, height: 600 }).y).toBeGreaterThanOrEqual(8);
  });
});

describe('showDelay', () => {
  it('waits at first, and not at all just after another tooltip closed', () => {
    expect(showDelay(10_000, null)).toBe(SHOW_DELAY_MS);
    expect(showDelay(10_000, 9_800)).toBe(0);
    expect(showDelay(10_000, 9_000)).toBe(SHOW_DELAY_MS);
  });
});
