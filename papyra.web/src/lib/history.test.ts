import { describe, expect, it } from 'vitest';
import { chronological, diffStats, foldUnchanged, formatStamp, relativeTime } from './history';
import { lineDiff } from './lineDiff';

describe('chronological', () => {
  it('orders oldest → newest without mutating the input', () => {
    const input = [
      { id: '3', timestamp: '2026-09-25T10:00:00Z' },
      { id: '1', timestamp: '2026-09-24T10:00:00Z' },
      { id: '2', timestamp: '2026-09-24T12:00:00Z' },
    ];
    expect(chronological(input).map((v) => v.id)).toEqual(['1', '2', '3']);
    expect(input[0].id).toBe('3');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  it.each([
    [new Date('2026-09-25T11:59:40Z'), 'just now'],
    [new Date('2026-09-25T11:55:00Z'), '5 minutes ago'],
    [new Date('2026-09-25T09:00:00Z'), '3 hours ago'],
    [new Date('2026-09-24T12:00:00Z'), 'yesterday'],
    [new Date('2026-09-18T12:00:00Z'), 'last week'],
  ])('%s → %s', (then, text) => {
    expect(relativeTime(then, now, 'en')).toBe(text);
  });
});

describe('formatStamp', () => {
  it('omits the year only when it is this year', () => {
    const now = new Date(2026, 8, 25, 12);
    expect(formatStamp(new Date(2026, 8, 25, 15, 31), now, 'en-US')).toMatch(/^Sep 25, 3:31\sPM$/);
    expect(formatStamp(new Date(2025, 0, 2, 9, 5), now, 'en-US')).toContain('2025');
  });
});

describe('diffStats', () => {
  it('counts lines on each side', () => {
    expect(diffStats(lineDiff('a\nb\nc', 'a\nc\nd\ne'))).toEqual({ added: 2, removed: 1 });
    expect(diffStats(lineDiff('same', 'same'))).toEqual({ added: 0, removed: 0 });
  });
});

describe('foldUnchanged', () => {
  const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('keeps context around a change and folds the long runs either side', () => {
    const before = lines(20).join('\n');
    const after = lines(20).map((l) => (l === 'l10' ? 'CHANGED' : l)).join('\n');
    const out = foldUnchanged(lineDiff(before, after), 3);
    expect(out[0]).toMatchObject({ type: 'fold' });
    expect((out[0] as { rows: unknown[] }).rows).toHaveLength(7); // l0–l6
    const shown = out.filter((r) => r.type === 'row').map((r) => (r as { text: string }).text);
    expect(shown).toEqual(['l7', 'l8', 'l9', 'l10', 'CHANGED', 'l11', 'l12', 'l13']);
    expect(out[out.length - 1]).toMatchObject({ type: 'fold' });
  });

  it('never folds a single line (a control for one line is noise)', () => {
    const before = ['a', 'b', 'c', 'd', 'x', 'e'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'y', 'e'].join('\n');
    const out = foldUnchanged(lineDiff(before, after), 3);
    expect(out.every((r) => r.type === 'row')).toBe(true);
  });

  it('folds everything when nothing changed, and nothing is lost when unfolded', () => {
    const rows = lineDiff(lines(10).join('\n'), lines(10).join('\n'));
    const out = foldUnchanged(rows);
    expect(out).toHaveLength(1);
    const flat = out.flatMap((r) => (r.type === 'fold' ? r.rows : [r]));
    expect(flat.map((r) => r.text)).toEqual(rows.map((r) => r.text));
  });

  it('handles an empty diff', () => {
    expect(foldUnchanged([])).toEqual([]);
  });
});
