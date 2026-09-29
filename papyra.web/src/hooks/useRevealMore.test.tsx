// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRevealMore } from './useRevealMore';

// The desk mounts a screenful or two of cards and reveals more as the end nears.
// jsdom has no IntersectionObserver; this fake lets a test say "the sentinel is
// on screen now" — and, like the real one, reports once on observe().

let observers: { cb: IntersectionObserverCallback; visible: boolean }[] = [];
let sentinelVisible = false;

class FakeIO {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) { this.cb = cb; }
  observe() {
    const entry = { isIntersecting: sentinelVisible } as IntersectionObserverEntry;
    observers.push({ cb: this.cb, visible: sentinelVisible });
    this.cb([entry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
}

beforeEach(() => {
  observers = [];
  sentinelVisible = false;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('innerHeight', 800);
});
afterEach(() => vi.unstubAllGlobals());

describe('useRevealMore', () => {
  it('starts with a screenful plus as much again, sized by the column count', () => {
    const { result } = renderHook(() => useRevealMore(500, 4));
    // 4 columns × (ceil(800 / 160) + 2) rows.
    expect(result.current.shown).toBe(28);
  });

  it('never claims more than there is', () => {
    const { result } = renderHook(() => useRevealMore(5, 4));
    expect(result.current.shown).toBe(5);
  });

  it('reveals the next batch when the sentinel nears the viewport, and keeps going while it stays there', () => {
    const { result } = renderHook(() => useRevealMore(100, 4));
    act(() => result.current.sentinelRef(document.createElement('div')));
    expect(result.current.shown).toBe(28); // off screen: nothing more

    sentinelVisible = true;
    act(() => result.current.sentinelRef(document.createElement('div'))); // re-observe
    // Each growth re-observes; a sentinel still on screen pulls batch after batch until the end.
    expect(result.current.shown).toBe(100);
  });
});
