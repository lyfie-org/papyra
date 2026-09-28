import { describe, expect, it } from 'vitest';
import { purgeInfo } from './trashPurge';

const now = new Date(2026, 8, 28, 12, 0);

describe('purgeInfo', () => {
  it('promises nothing when Trash keeps forever or the stamp is missing', () => {
    expect(purgeInfo(new Date(2026, 8, 1).toISOString(), -1, now)).toBeNull();
    expect(purgeInfo(null, 30, now)).toBeNull();
    expect(purgeInfo(new Date(2026, 8, 1).toISOString(), undefined, now)).toBeNull();
  });

  it('dates the purge from when the note was trashed', () => {
    const info = purgeInfo(new Date(2026, 8, 20, 9).toISOString(), 30, now)!;
    expect(info.label).toMatch(/^Deletes forever on /);
    expect(info.label).toMatch(/20/);
    expect(info.soon).toBe(false);
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
