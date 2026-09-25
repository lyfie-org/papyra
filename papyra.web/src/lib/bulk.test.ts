import { describe, it, expect } from 'vitest';
import { rangeBetween, nextSelection, shareSummary, planGroupDrop, idsWith, type ShareStatus } from './bulk';
import { keysBetween, ORDER_STEP } from '../hooks/useNoteOrder';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('rangeBetween (shift-click)', () => {
  it('selects everything between anchor and target, inclusive, both directions', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'c', 'c')).toEqual(['c']);
  });

  it('falls back to just the target when the anchor is unknown or gone', () => {
    expect(rangeBetween(order, null, 'c')).toEqual(['c']);
    expect(rangeBetween(order, 'deleted', 'c')).toEqual(['c']);
  });

  it('selects nothing for a target that is not on screen', () => {
    expect(rangeBetween(order, 'a', 'zzz')).toEqual([]);
  });
});

describe('nextSelection', () => {
  it('toggles a single card on and off without touching the rest', () => {
    const one = nextSelection(new Set(['a']), order, 'a', 'c', false);
    expect([...one].sort()).toEqual(['a', 'c']);
    const back = nextSelection(one, order, 'c', 'c', false);
    expect([...back]).toEqual(['a']);
  });

  it('shift adds the whole range and never deselects inside it', () => {
    const start = new Set(['a', 'c']);
    const next = nextSelection(start, order, 'a', 'e', true);
    expect([...next].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('shift with no anchor behaves like a plain toggle', () => {
    expect([...nextSelection(new Set(), order, null, 'd', true)]).toEqual(['d']);
  });

  it('never mutates the set it was given', () => {
    const start = new Set(['a']);
    nextSelection(start, order, 'a', 'b', false);
    expect([...start]).toEqual(['a']);
  });
});

describe('shareSummary', () => {
  const result = (statuses: ShareStatus[]) => ({
    grantee: 'bea',
    results: statuses.map((status, i) => ({ id: `n${i}`, status })),
  });

  it('counts upgrades as shared and names every skip', () => {
    expect(shareSummary(result(['shared', 'upgraded', 'alreadyShared', 'locked', 'locked', 'notFound'])))
      .toBe('Shared 2 notes with bea. 1 note was already shared. 2 locked notes skipped — unlock them to share. 1 note couldn\'t be found.');
  });

  it('says so plainly when nothing new was shared', () => {
    expect(shareSummary(result(['alreadyShared', 'alreadyShared'])))
      .toBe('Nothing new to share with bea. 2 notes were already shared.');
  });

  it('uses the singular for one note', () => {
    expect(shareSummary(result(['shared']))).toBe('Shared 1 note with bea.');
    expect(shareSummary(result(['shared', 'locked']))).toContain('1 locked note skipped — unlock it to share.');
  });

  it('idsWith filters by status in server order', () => {
    expect(idsWith(result(['shared', 'locked', 'shared']), 'shared')).toEqual(['n0', 'n2']);
  });
});

describe('keysBetween', () => {
  const descending = (keys: number[]) => keys.every((k, i) => i === 0 || keys[i - 1] > k);

  it('spreads keys strictly between two neighbours, highest first', () => {
    const keys = keysBetween(1000, 0, 4);
    expect(keys).toHaveLength(4);
    expect(descending(keys)).toBe(true);
    expect(Math.max(...keys)).toBeLessThan(1000);
    expect(Math.min(...keys)).toBeGreaterThan(0);
  });

  it('leaves room for a later single drop between any two of them', () => {
    const keys = keysBetween(10, 9, 50);
    expect(new Set(keys).size).toBe(50);
    expect(descending(keys)).toBe(true);
  });

  it('stacks above the top card and below the bottom one', () => {
    expect(keysBetween(null, 500, 3)).toEqual([500 + 3 * ORDER_STEP, 500 + 2 * ORDER_STEP, 500 + ORDER_STEP]);
    expect(keysBetween(500, null, 2)).toEqual([500 - ORDER_STEP, 500 - 2 * ORDER_STEP]);
  });

  it('handles an empty section and the trivial counts', () => {
    const keys = keysBetween(null, null, 3);
    expect(descending(keys)).toBe(true);
    expect(keysBetween(1, 0, 0)).toEqual([]);
    expect(keysBetween(10, 0, 1)).toEqual([5]);
  });
});

describe('planGroupDrop', () => {
  // A section of cards whose keys descend 90, 80, … (display order).
  const section = ['p', 'q', 'r', 's'];
  const key = (id: string) => ({ p: 90, q: 80, r: 70, s: 60 } as Record<string, number>)[id];

  const landed = (plan: Map<string, number>) => {
    const all = new Map<string, number>([...section.map((id) => [id, key(id)] as const), ...plan]);
    return [...all.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };

  it('lands the group contiguous, in its own order, at the drop slot', () => {
    expect(landed(planGroupDrop(['x', 'y', 'z'], section, 2, key, keysBetween)))
      .toEqual(['p', 'q', 'x', 'y', 'z', 'r', 's']);
  });

  it('can land at the very top and the very bottom', () => {
    expect(landed(planGroupDrop(['x', 'y'], section, 0, key, keysBetween)))
      .toEqual(['x', 'y', 'p', 'q', 'r', 's']);
    expect(landed(planGroupDrop(['x', 'y'], section, 4, key, keysBetween)))
      .toEqual(['p', 'q', 'r', 's', 'x', 'y']);
  });

  it('clamps an out-of-range index instead of losing the group', () => {
    expect(landed(planGroupDrop(['x'], section, 99, key, keysBetween))).toEqual(['p', 'q', 'r', 's', 'x']);
    expect(landed(planGroupDrop(['x'], section, -3, key, keysBetween))).toEqual(['x', 'p', 'q', 'r', 's']);
  });

  it('drops into an empty section', () => {
    const plan = planGroupDrop(['x', 'y'], [], 0, key, keysBetween);
    expect(plan.get('x')!).toBeGreaterThan(plan.get('y')!);
  });
});
