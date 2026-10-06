// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('./serverVersion', () => ({ checkServerVersion: vi.fn(async () => null) }));

import { checkServerVersion } from './serverVersion';
import { installResumeRefresh, RESUME_EVENT } from './resume';

// The app's freshness is pushed by SignalR, so a phone PWA that was backgrounded
// (socket dead, events missed) must catch up on its own when it comes back.

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('installResumeRefresh', () => {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const resumed = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    invalidate.mockClear();
    resumed.mockClear();
    vi.mocked(checkServerVersion).mockClear();
    window.addEventListener(RESUME_EVENT, resumed);
  });
  afterEach(() => {
    window.removeEventListener(RESUME_EVENT, resumed);
    vi.useRealTimers();
  });

  installResumeRefresh(queryClient);

  it('catches up when the app returns after being away', () => {
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    setHidden(false);

    expect(resumed).toHaveBeenCalledTimes(1);
    expect(checkServerVersion).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('leaves notes to the hub listener (focus-mode buffer)', () => {
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    setHidden(false);

    const { predicate } = invalidate.mock.calls[0][0] as unknown as { predicate: (q: { queryKey: unknown[] }) => boolean };
    expect(predicate({ queryKey: ['notes'] })).toBe(false);
    expect(predicate({ queryKey: ['shares', 'incoming'] })).toBe(true);
    expect(predicate({ queryKey: ['auth'] })).toBe(true);
  });

  it('ignores a quick app-switch glance', () => {
    setHidden(true);
    vi.advanceTimersByTime(1_000);
    setHidden(false);

    expect(resumed).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does nothing while offline', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setHidden(true);
    vi.advanceTimersByTime(60_000);
    setHidden(false);
    online.mockRestore();

    expect(resumed).not.toHaveBeenCalled();
  });

  it('catches up when restored from the back/forward cache', () => {
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    expect(resumed).toHaveBeenCalledTimes(1);
  });
});
