// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import TooltipLayer from './TooltipLayer';

function pointer(type: 'pointerover' | 'pointerout' | 'pointerdown', target: Element, init: { related?: Element | null; pointerType?: string } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: init.related ?? null });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  act(() => { target.dispatchEvent(e); });
}
const over = (el: Element, init?: { pointerType?: string }) => pointer('pointerover', el, init);
const out = (el: Element, related: Element | null = document.body) => pointer('pointerout', el, { related });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => screen.queryByRole('tooltip');

function mount(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

beforeEach(() => { vi.useFakeTimers(); render(<TooltipLayer />); });
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('TooltipLayer', () => {
  it('opens after a short wait over a control that asks for one, not before', () => {
    const root = mount('<button id="a" data-tooltip="Share this note" aria-label="Share note">x</button>');
    over(root.querySelector('#a')!);
    expect(tip()).toBeNull();
    wait(300);
    expect(tip()).toBeNull();
    wait(200);
    expect(tip()!.textContent).toBe('Share this note');
  });

  it('draws a shortcut as keycaps', () => {
    const root = mount('<button id="a" data-tooltip="Next day" data-tooltip-keys="Alt+Shift+→">x</button>');
    over(root.querySelector('#a')!);
    wait(500);
    expect([...tip()!.querySelectorAll('kbd')].map(k => k.textContent)).toEqual(['Alt', 'Shift', '→']);
  });

  it('closes when the pointer leaves, after a moment of grace', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    const a = root.querySelector('#a')!;
    over(a); wait(500);
    out(a);
    wait(50);
    expect(tip()).not.toBeNull();
    wait(150);
    expect(tip()).toBeNull();
  });

  it('stays open while the pointer is on the tooltip itself, so it can be read', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    const a = root.querySelector('#a')!;
    over(a); wait(500);
    out(a, tip());                                  // pointer moves from the control onto the tooltip
    wait(500);
    expect(tip()).not.toBeNull();
    over(tip()!);
    wait(500);
    expect(tip()).not.toBeNull();
    out(tip()!);                                    // and away from it
    wait(200);
    expect(tip()).toBeNull();
  });

  it('shows the next control’s tooltip at once while moving along a row', () => {
    const root = mount('<button id="a" data-tooltip="One">x</button><button id="b" data-tooltip="Two">y</button>');
    over(root.querySelector('#a')!); wait(500);
    expect(tip()!.textContent).toBe('One');
    out(root.querySelector('#a')!, root.querySelector('#b'));
    over(root.querySelector('#b')!);
    expect(tip()!.textContent).toBe('Two');          // no wait
  });

  it('is warm for a moment after one closes, then cold again', () => {
    const root = mount('<button id="a" data-tooltip="One">x</button><button id="b" data-tooltip="Two">y</button>');
    over(root.querySelector('#a')!); wait(500);
    out(root.querySelector('#a')!); wait(200);
    expect(tip()).toBeNull();
    over(root.querySelector('#b')!);
    expect(tip()!.textContent).toBe('Two');
    out(root.querySelector('#b')!); wait(200);
    wait(2000);
    over(root.querySelector('#a')!);
    expect(tip()).toBeNull();                        // cold again
  });

  it('closes on Escape without letting the key reach anything else', () => {
    const root = mount('<div id="dialog"><button id="a" data-tooltip="Hi">x</button></div>');
    const reached = vi.fn();
    root.querySelector('#dialog')!.addEventListener('keydown', reached);
    over(root.querySelector('#a')!); wait(500);
    act(() => { root.querySelector('#a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(tip()).toBeNull();
    expect(reached).not.toHaveBeenCalled();
    // With nothing open, Escape is left alone for the dialog.
    act(() => { root.querySelector('#a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(reached).toHaveBeenCalledOnce();
  });

  it('opens at once on keyboard focus and closes on blur', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    const a = root.querySelector<HTMLElement>('#a')!;
    vi.spyOn(a, 'matches').mockReturnValue(true);
    act(() => a.focus());
    expect(tip()!.textContent).toBe('Hi');
    act(() => a.blur());
    expect(tip()).toBeNull();
  });

  it('does not open for a mouse click’s focus (not :focus-visible), a form field, or the editor', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button><input id="i" data-tooltip="Hi"><div id="e" contenteditable="true" data-tooltip="Hi"></div>');
    const a = root.querySelector<HTMLElement>('#a')!;
    vi.spyOn(a, 'matches').mockReturnValue(false);
    act(() => a.focus());
    expect(tip()).toBeNull();
    act(() => root.querySelector<HTMLElement>('#i')!.focus());
    expect(tip()).toBeNull();
    const e = root.querySelector<HTMLElement>('#e')!;
    Object.defineProperty(e, 'isContentEditable', { value: true });
    act(() => e.focus());
    expect(tip()).toBeNull();
  });

  it('ignores touch, which has no hover', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    over(root.querySelector('#a')!, { pointerType: 'touch' });
    wait(1000);
    expect(tip()).toBeNull();
  });

  it('closes on a click, a scroll and a resize', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    const a = root.querySelector('#a')!;
    for (const close of [
      () => pointer('pointerdown', a),
      () => act(() => { document.dispatchEvent(new Event('scroll')); }),
      () => act(() => { window.dispatchEvent(new Event('resize')); }),
    ]) {
      over(a); wait(500);
      expect(tip()).not.toBeNull();
      close();
      expect(tip()).toBeNull();
      out(a); wait(200);
    }
  });

  it('lends a plain title to the tooltip and hands it back, so the browser’s own never shows over it', () => {
    const root = mount('<button id="a" title="Bold (Ctrl+B)">x</button>');
    const a = root.querySelector('#a')!;
    over(a);
    expect(a.hasAttribute('title')).toBe(false);     // taken at once, before the browser's own wait
    wait(500);
    expect(tip()!.querySelector('.tip__text')!.textContent).toBe('Bold');
    expect([...tip()!.querySelectorAll('kbd')].map(k => k.textContent)).toEqual(['Ctrl', 'B']);
    out(a); wait(200);
    expect(a.getAttribute('title')).toBe('Bold (Ctrl+B)');
  });

  it('gives a title back even if the pointer leaves before the tooltip opened', () => {
    const root = mount('<button id="a" title="Bold">x</button>');
    const a = root.querySelector('#a')!;
    over(a); wait(100); out(a);
    expect(a.getAttribute('title')).toBe('Bold');
    wait(1000);
    expect(tip()).toBeNull();
  });

  it('links the tooltip to the control only when it adds to the name', () => {
    const root = mount('<button id="a" data-tooltip="Share with someone else" aria-label="Share note">x</button><button id="b" aria-label="Notifications"><svg></svg></button>');
    const a = root.querySelector('#a')!, b = root.querySelector('#b')!;
    over(a); wait(500);
    expect(a.getAttribute('aria-describedby')).toBe('papyra-tooltip');
    expect(tip()!.id).toBe('papyra-tooltip');
    out(a); wait(200);
    expect(a.hasAttribute('aria-describedby')).toBe(false);

    over(b); wait(500);
    expect(tip()!.textContent).toBe('Notifications');     // lent from the aria-label
    expect(b.hasAttribute('aria-describedby')).toBe(false);   // it would only say the name twice
  });

  it('closes if its control is removed while it is open', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    over(root.querySelector('#a')!); wait(500);
    expect(tip()).not.toBeNull();
    root.querySelector('#a')!.remove();
    wait(500);
    expect(tip()).toBeNull();
  });

  it('does nothing for an element with no tooltip, and for a control showing its own label', () => {
    const root = mount('<p id="p">Hello</p><button id="b" aria-label="Today">Today</button>');
    over(root.querySelector('#p')!); over(root.querySelector('#b')!);
    wait(1000);
    expect(tip()).toBeNull();
  });

  it('is placed in a portal on the body and positioned', () => {
    const root = mount('<button id="a" data-tooltip="Hi">x</button>');
    over(root.querySelector('#a')!); wait(500);
    const el = tip()!;
    expect(el.parentElement).toBe(document.body);
    expect(el.dataset.ready).toBe('true');
    expect(el.style.left).toMatch(/px$/);
  });
});
