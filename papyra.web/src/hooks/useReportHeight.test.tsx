// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReportHeight } from './useReportHeight';

// A masonry card's height moves with no render of its own (a font landing, an
// image decoding); the hook must report each change, and stop on unmount.

let callback: ResizeObserverCallback | null = null;
const disconnect = vi.fn();

class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) { callback = cb; }
  observe() {}
  unobserve() {}
  disconnect = disconnect;
}

afterEach(() => { callback = null; disconnect.mockClear(); vi.unstubAllGlobals(); });

describe('useReportHeight', () => {
  it('reports the element height every time it resizes', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 120 });
    const onMeasure = vi.fn();

    const { unmount } = renderHook(() => useReportHeight({ current: el }, 'n1', onMeasure));

    callback?.([], {} as ResizeObserver);
    expect(onMeasure).toHaveBeenLastCalledWith('n1', 120);

    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 168 });
    callback?.([], {} as ResizeObserver);
    expect(onMeasure).toHaveBeenLastCalledWith('n1', 168);

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('does nothing without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const onMeasure = vi.fn();
    expect(() => renderHook(() => useReportHeight({ current: document.createElement('div') }, 'n1', onMeasure))).not.toThrow();
    expect(onMeasure).not.toHaveBeenCalled();
  });
});
