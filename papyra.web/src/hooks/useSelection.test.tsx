// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSelection } from './useSelection';

// Selection is a mode entered by the first tick. The rough edges that matter:
// cards vanishing mid-selection, shift ranges, and the keyboard never stealing
// a shortcut from a text field or an open dialog.

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('useSelection', () => {
  it('starts idle, enters the mode on the first tick, leaves it on the last untick', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    expect(result.current.active).toBe(false);
    act(() => result.current.toggle('b'));
    expect(result.current.active).toBe(true);
    expect([...result.current.selected]).toEqual(['b']);
    act(() => result.current.toggle('b'));
    expect(result.current.active).toBe(false);
  });

  it('shift-click extends from the last card clicked', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c', 'd']));
    act(() => result.current.toggle('d'));
    act(() => result.current.toggle('a', true));
    expect([...result.current.selected].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a shift-click as the very first click selects only that card', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    act(() => result.current.toggle('c', true));
    expect([...result.current.selected]).toEqual(['c']);
  });

  it('drops cards that leave the grid — actions never see a vanished note', () => {
    let ids = ['a', 'b', 'c'];
    const { result, rerender } = renderHook(() => useSelection(ids));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('b'));
    ids = ['b', 'c']; // 'a' deleted elsewhere (another tab, a sync)
    rerender();
    expect([...result.current.selected]).toEqual(['b']);
    ids = ['c'];
    rerender();
    expect(result.current.active).toBe(false);
  });

  it('a card that comes back is not silently re-selected after being pruned by a later toggle', () => {
    let ids = ['a', 'b'];
    const { result, rerender } = renderHook(() => useSelection(ids));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('b'));
    ids = ['b'];
    rerender();
    act(() => result.current.toggle('b')); // clears the live selection
    ids = ['a', 'b'];
    rerender();
    expect(result.current.active).toBe(false);
  });

  it('Escape clears; Ctrl/Cmd+A selects every card, only while selecting', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']));
    press('a', { ctrlKey: true });
    expect(result.current.active).toBe(false); // outside the mode, the browser keeps its select-all

    act(() => result.current.toggle('a'));
    press('a', { metaKey: true });
    expect(result.current.selected.size).toBe(3);
    press('Escape');
    expect(result.current.active).toBe(false);
  });

  it('leaves Ctrl+A alone inside a text field', () => {
    const { result } = renderHook(() => useSelection(['a', 'b']));
    act(() => result.current.toggle('a'));
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('a', { ctrlKey: true }, input);
    expect(result.current.selected.size).toBe(1);
  });

  it('lets an open dialog own Escape', () => {
    const { result } = renderHook(() => useSelection(['a']));
    act(() => result.current.toggle('a'));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    press('Escape');
    expect(result.current.active).toBe(true);
  });

  it('survives rapid repeated toggles (double-clicks, key repeat)', () => {
    const { result } = renderHook(() => useSelection(['a', 'b']));
    act(() => { for (let i = 0; i < 7; i++) result.current.toggle('a'); });
    expect([...result.current.selected]).toEqual(['a']); // odd count → on
  });
});
