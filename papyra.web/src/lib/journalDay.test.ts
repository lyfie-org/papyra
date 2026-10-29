import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, daysBetween, isDay, longDate, monthGrid, parseLooseDay, relativeName, todayIn, weekday,
} from './journalDay';

// The same table as JournalCoreTests.Today_FollowsTheZoneAndTheDayStart (C#) —
// the client's offline fallback must agree with the server's rule.
const SHARED: [string | null, string, number, string][] = [
  ['America/New_York', '2026-10-25T03:30:00Z', 0, '2026-10-24'],
  ['America/New_York', '2026-10-25T04:00:00Z', 0, '2026-10-25'],
  ['America/New_York', '2026-11-01T05:30:00Z', 0, '2026-11-01'],
  ['America/New_York', '2026-11-01T06:30:00Z', 0, '2026-11-01'],
  ['America/New_York', '2026-03-08T06:59:00Z', 0, '2026-03-08'],
  ['America/New_York', '2026-03-08T07:00:00Z', 0, '2026-03-08'],
  ['Europe/London', '2026-03-29T00:59:00Z', 0, '2026-03-29'],
  ['Europe/London', '2026-10-25T00:30:00Z', 0, '2026-10-25'],
  ['Europe/London', '2026-10-25T23:59:00Z', 0, '2026-10-25'],
  ['Pacific/Auckland', '2026-10-24T11:30:00Z', 0, '2026-10-25'],
  ['Asia/Kolkata', '2026-10-24T18:29:00Z', 0, '2026-10-24'],
  ['Asia/Kolkata', '2026-10-24T18:30:00Z', 0, '2026-10-25'],
  ['Asia/Kolkata', '2026-10-24T20:00:00Z', 3, '2026-10-24'],
  ['Asia/Kolkata', '2026-10-24T21:30:00Z', 3, '2026-10-25'],
  ['America/New_York', '2026-11-01T06:30:00Z', 2, '2026-10-31'],
  ['Not/AZone', '2026-10-25T23:30:00Z', 0, '2026-10-25'],
  [null, '2026-10-25T00:00:00Z', 0, '2026-10-25'],
  ['UTC', '2026-10-25T01:00:00Z', 99, '2026-10-24'],
];

describe('todayIn', () => {
  it.each(SHARED)('%s at %s with day start %i is %s', (zone, utc, start, expected) => {
    expect(todayIn(new Date(utc), zone, start)).toBe(expected);
  });
});

describe('isDay', () => {
  it.each([
    ['2026-10-25', true], ['2024-02-29', true], ['2026-02-29', false], ['2026-02-30', false],
    ['2026-13-01', false], ['2026-1-5', false], ['2026-10-5', false], [' 2026-10-25', false],
    ['2026-10-25x', false], ['', false], ['..', false], ['1899-12-31', false],
  ])('%s → %s', (text, ok) => expect(isDay(text)).toBe(ok));
});

describe('day arithmetic', () => {
  it('crosses months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(daysBetween('2026-10-20', '2026-10-25')).toBe(5);
    expect(daysBetween('2026-10-25', '2026-10-20')).toBe(-5);
  });

  it('knows its weekdays and names its days', () => {
    expect(weekday('2026-10-25')).toBe(0); // a Sunday
    expect(relativeName('2026-10-25', '2026-10-25')).toBe('Today');
    expect(relativeName('2026-10-24', '2026-10-25')).toBe('Yesterday');
    expect(relativeName('2026-10-26', '2026-10-25')).toBe('Tomorrow');
    expect(relativeName('2026-10-21', '2026-10-25', 'en-GB')).toBe('Wednesday');
    expect(longDate('2026-10-25', 'en-GB')).toBe('25 October 2026');
  });
});

describe('monthGrid', () => {
  it('pads to whole weeks, Monday first', () => {
    const weeks = monthGrid(2026, 10, 1); // 1 October 2026 is a Thursday
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]).toBe('2026-10-01');
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.at(-1)!.at(-1)).toBeNull();
  });

  it('can start on Sunday', () => {
    expect(monthGrid(2026, 2, 0)[0][0]).toBe('2026-02-01'); // a Sunday
    expect(monthGrid(2026, 2, 0)).toHaveLength(4);
  });
});

describe('parseLooseDay', () => {
  const today = '2026-10-25'; // a Sunday
  it.each([
    ['today', '2026-10-25'],
    ['Yesterday', '2026-10-24'],
    ['3 days ago', '2026-10-22'],
    ['fri', '2026-10-23'],
    ['last fri', '2026-10-23'],
    ['sunday', '2026-10-18'],       // never today itself: the previous one
    ['sep 14', '2026-09-14'],
    ['14 sep', '2026-09-14'],
    ['september 14, 2024', '2024-09-14'],
    ['dec 25', '2025-12-25'],       // not yet this year: last year's
    ['2024-03-02', '2024-03-02'],
    ['feb 29', '2024-02-29'],       // the latest 29 February
  ])('%s → %s', (text, expected) => expect(parseLooseDay(text, today)).toBe(expected));

  it.each(['', 'hello', 'sep 31', 'xx 4', '2026-02-30', 'sep'])('%s is not a day', (text) =>
    expect(parseLooseDay(text, today)).toBeNull());
});
