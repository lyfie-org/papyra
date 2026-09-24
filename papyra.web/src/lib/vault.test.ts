// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentUnlockToken, forgetUnlock, parseUtc, pinProblem, rememberUnlock, subscribeUnlock } from './vault';

describe('pinProblem (mirrors Security/VaultPin.cs)', () => {
  it.each(['', '12a456', '48091', '4809134809134', '000000', '123456', '987654', '789012', '210987'])(
    'rejects %j', (pin) => expect(pinProblem(pin)).not.toBeNull(),
  );
  it.each(['480913', '135790', '558811223344'])('accepts %s', (pin) => expect(pinProblem(pin)).toBeNull());
});

describe('parseUtc', () => {
  it('reads a timestamp without a zone as UTC, not local time', () => {
    expect(parseUtc('2026-09-24T18:05:04.6951297').toISOString()).toBe('2026-09-24T18:05:04.695Z');
  });
  it('leaves explicit zones alone', () => {
    expect(parseUtc('2026-09-24T18:05:04Z').toISOString()).toBe('2026-09-24T18:05:04.000Z');
    expect(parseUtc('2026-09-24T23:35:04+05:30').toISOString()).toBe('2026-09-24T18:05:04.000Z');
  });
});

describe('unlock token', () => {
  afterEach(() => { forgetUnlock(); vi.useRealTimers(); });

  it('is held in memory, never in web storage', () => {
    rememberUnlock('abc');
    expect(currentUnlockToken()).toBe('abc');
    expect(JSON.stringify({ ...localStorage })).not.toContain('abc');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('abc');
  });

  it('lapses before the server would refuse it, and tells subscribers', () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    const off = subscribeUnlock(seen);
    rememberUnlock('abc');
    vi.advanceTimersByTime(5 * 60_000 - 14_000);
    expect(currentUnlockToken()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2); // opened, then closed
    off();
  });
});
