// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import TopProgressBar, { SHOW_AFTER_MS } from './TopProgressBar';
import LoadingBar from './LoadingBar';
import { beginTask } from '../lib/progress';
import { ease } from '../hooks/useFlipPosition';

// The top line is a fallback: it shows only for a slow first load that nothing
// else on screen is showing. Saves, tasks and quick loads never light it.

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function ColdLoad({ withLoader = false }: { withLoader?: boolean }) {
  const q = useQuery({ queryKey: ['cold'], queryFn: never, retry: false });
  return withLoader && q.isLoading ? <LoadingBar label="Loading" /> : null;
}

function Mutating() {
  const m = useMutation({ mutationFn: never });
  useEffect(() => { m.mutate(undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function mount(children: React.ReactNode) {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <TopProgressBar />
      {children}
    </QueryClientProvider>,
  );
  return view.container.querySelector('.top-progress__bar') as HTMLDivElement;
}

const scale = (el: HTMLElement) => Number(/scaleX\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 0);
const lit = (el: HTMLElement) => el.style.opacity === '1';

describe('TopProgressBar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows for a slow first load nothing else is showing, and trickles without claiming done', async () => {
    const bar = mount(<ColdLoad />);
    await act(async () => { vi.advanceTimersByTime(0); }); // the query starts fetching
    await act(async () => { vi.advanceTimersByTime(SHOW_AFTER_MS - 100); });
    expect(lit(bar)).toBe(false);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(lit(bar)).toBe(true);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(scale(bar)).toBeGreaterThan(0.5);
    expect(scale(bar)).toBeLessThanOrEqual(0.9);
  });

  it('stays out of the way when the page shows its own loader', async () => {
    const bar = mount(<ColdLoad withLoader />);
    await act(async () => { vi.advanceTimersByTime(SHOW_AFTER_MS * 3); });
    expect(lit(bar)).toBe(false);
  });

  it('never lights for a mutation', async () => {
    const bar = mount(<Mutating />);
    await act(async () => { vi.advanceTimersByTime(SHOW_AFTER_MS * 3); });
    expect(lit(bar)).toBe(false);
  });

  it('never lights for a task, named or not', async () => {
    const bar = mount(null);
    let plain!: ReturnType<typeof beginTask>;
    let named!: ReturnType<typeof beginTask>;
    act(() => { plain = beginTask(); named = beginTask({ label: 'Backing up' }); });
    await act(async () => { vi.advanceTimersByTime(SHOW_AFTER_MS * 3); });
    expect(lit(bar)).toBe(false);
    act(() => { plain.end(); named.end(); });
  });

  it('a dock card hides it too', async () => {
    const bar = mount(<ColdLoad />);
    let named!: ReturnType<typeof beginTask>;
    act(() => { named = beginTask({ label: 'Restoring' }); });
    await act(async () => { vi.advanceTimersByTime(SHOW_AFTER_MS * 3); });
    expect(lit(bar)).toBe(false);
    act(() => named.end());
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
