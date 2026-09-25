// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TopProgressBar from './TopProgressBar';
import { beginTask, getActivity } from '../lib/progress';
import { ease } from '../hooks/useFlipPosition';

// The bar is judged by what it looks like over time: it has to appear at once,
// never finish in a flicker (a microsecond task still gets a ~500ms sweep), and
// get out of the way afterwards.

function mount() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <TopProgressBar />
    </QueryClientProvider>,
  );
  return view.container.querySelector('.top-progress__bar') as HTMLDivElement;
}

const scale = (el: HTMLElement) => Number(/scaleX\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 0);

describe('TopProgressBar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('stretches an instant task to a deliberate sweep, then fades out', async () => {
    const bar = mount();
    let task!: ReturnType<typeof beginTask>;
    act(() => { task = beginTask(); });
    await act(async () => { vi.advanceTimersByTime(32); });
    expect(bar.style.opacity).toBe('1');

    act(() => task.end()); // done after ~30ms
    await act(async () => { vi.advanceTimersByTime(250); });
    // Still sweeping: well short of the 500ms floor.
    expect(bar.style.opacity).toBe('1');
    expect(scale(bar)).toBeLessThan(1);

    await act(async () => { vi.advanceTimersByTime(900); });
    expect(bar.style.opacity).toBe('0');
    expect(getActivity().active).toBe(0);
  });

  it('follows real progress when a task reports it', async () => {
    const bar = mount();
    let task!: ReturnType<typeof beginTask>;
    act(() => { task = beginTask(); });
    act(() => task.update(0.75));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(scale(bar)).toBeGreaterThan(0.7);
    expect(scale(bar)).toBeLessThan(1);
    act(() => task.end());
    await act(async () => { vi.advanceTimersByTime(1000); });
  });

  it('trickles without ever claiming to be done', async () => {
    const bar = mount();
    let task!: ReturnType<typeof beginTask>;
    act(() => { task = beginTask(); });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(scale(bar)).toBeGreaterThan(0.5);
    expect(scale(bar)).toBeLessThanOrEqual(0.9);
    act(() => task.end());
    await act(async () => { vi.advanceTimersByTime(1000); });
  });
});

describe('ease', () => {
  it('is pinned at both ends and monotonic in between', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let p = 0.05; p < 1; p += 0.05) {
      const v = ease(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // Ease-out: most of the distance is covered early.
    expect(ease(0.3)).toBeGreaterThan(0.6);
  });
});
