import { describe, expect, it } from 'vitest';
import { expandTemplate, streakWith } from './journalTemplates';

describe('expandTemplate', () => {
  const ctx = { day: '2026-10-25', streak: 12 };

  it('fills the date, the weekday and the streak, however they are spaced or cased', () => {
    expect(expandTemplate('# {{date}}\n{{ Weekday }} · day {{STREAK}}', ctx))
      .toBe('# October 25, 2026\nSunday · day 12');
  });

  it('fills every occurrence and leaves other braces alone', () => {
    expect(expandTemplate('{{date}} / {{date}} / {{mood}} / {not a token}', ctx))
      .toBe('October 25, 2026 / October 25, 2026 / {{mood}} / {not a token}');
  });

  it('leaves a template with no tokens untouched', () => {
    expect(expandTemplate('## One good thing\n', ctx)).toBe('## One good thing\n');
  });
});

describe('streakWith', () => {
  it('counts today once it is written, not before', () => {
    expect(streakWith({ current: 4, todayWritten: false }, true)).toBe(5);
    expect(streakWith({ current: 4, todayWritten: true }, true)).toBe(4);
  });

  it('does not invent one for an earlier day, or for no stats yet', () => {
    expect(streakWith({ current: 4, todayWritten: false }, false)).toBe(4);
    expect(streakWith({ current: 0, todayWritten: false }, false)).toBe(1);
    expect(streakWith(undefined, true)).toBe(1);
  });
});
