import { describe, expect, it } from 'vitest';
import { purgeInfo } from './trashPurge';

const now = new Date(2026, 8, 28, 12, 0);

describe('purgeInfo', () => {
  it('promises nothing when Trash keeps forever or the stamp is missing', () => {
    expect(purgeInfo(new Date(2026, 8, 1).toISOString(), -1, now)).toBeNull();
    expect(purgeInfo(null, 30, now)).toBeNull();
    expect(purgeInfo(new Date(2026, 8, 1).toISOString(), undefined, now)).toBeNull();
  });

  it('counts the days left from when the note was trashed, with the date in the tooltip', () => {
    // Trashed 20 Sep with 30 days → 20 Oct, 22 calendar days after 28 Sep.
    const info = purgeInfo(new Date(2026, 8, 20, 9).toISOString(), 30, now)!;
    expect(info.label).toBe('Deletes forever in 22 days');
    expect(info.title).toMatch(/^Deletes forever on /);
    expect(info.title).toMatch(/20/);
    expect(info.soon).toBe(false);
  });

  it('counts calendar days, not 24-hour blocks', () => {
    // Due 30 Sep at 09:00; at noon on the 28th that is under 48h but two days away.
    expect(purgeInfo(new Date(2026, 8, 27, 9).toISOString(), 3, now)!.label).toBe('Deletes forever in 2 days');
  });

  it('says tomorrow and flags it as soon', () => {
    const info = purgeInfo(new Date(2026, 8, 22, 15).toISOString(), 7, now)!;
    expect(info.label).toBe('Deletes forever tomorrow');
    expect(info.soon).toBe(true);
  });

  it('covers an overdue note the sweep has not reached yet', () => {
    expect(purgeInfo(new Date(2026, 7, 1).toISOString(), 3, now)!.label).toBe('Deletes forever soon');
  });
});
