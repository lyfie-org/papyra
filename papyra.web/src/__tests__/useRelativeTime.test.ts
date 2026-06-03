import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRelativeTime } from '../hooks/useRelativeTime';

describe('useRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for undefined', () => {
    const { result } = renderHook(() => useRelativeTime(undefined));
    expect(result.current).toBe('');
  });

  it('returns "Just now" for a timestamp less than 30s ago', () => {
    const iso = new Date(Date.now() - 10_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe('Just now');
  });

  it('returns "1 min ago" for a timestamp 60s ago', () => {
    const iso = new Date(Date.now() - 60_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe('1 min ago');
  });

  it('returns a minute count for timestamps 3–59 minutes ago', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe('5 mins ago');
  });

  it('returns "1 hr ago" for a timestamp ~1.5h ago', () => {
    const iso = new Date(Date.now() - 3601_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe('1 hr ago');
  });

  it('returns a "Yesterday" for timestamps 25–48h ago', () => {
    const iso = new Date(Date.now() - 25 * 3600_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe('Yesterday');
  });

  it('updates label when iso prop changes', () => {
    const recentIso = new Date(Date.now() - 10_000).toISOString();
    const { result, rerender } = renderHook(
      ({ iso }) => useRelativeTime(iso),
      { initialProps: { iso: recentIso } },
    );
    expect(result.current).toBe('Just now');

    const oldIso = new Date(Date.now() - 5 * 60_000).toISOString();
    act(() => rerender({ iso: oldIso }));
    expect(result.current).toBe('5 mins ago');
  });
});
