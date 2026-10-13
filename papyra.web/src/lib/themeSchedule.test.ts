import { describe, expect, it } from 'vitest';
import { msUntilNextChange, parseSchedule, serializeSchedule, themeAt } from './themeSchedule';

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 9, 13, h, m, 0, 0);
};

describe('theme schedule', () => {
  it('round-trips the stored form and refuses anything else', () => {
    const s = { lightAt: '07:00', darkAt: '19:30' };
    expect(parseSchedule(serializeSchedule(s))).toEqual(s);
    expect(parseSchedule('schedule:07:00-07:00')).toBeNull();
    expect(parseSchedule('schedule:24:00-07:00')).toBeNull();
    expect(parseSchedule('system')).toBeNull();
  });

  it('is light from lightAt up to darkAt', () => {
    const day = { lightAt: '07:00', darkAt: '19:00' };
    expect(themeAt(day, at('06:59'))).toBe('dark');
    expect(themeAt(day, at('07:00'))).toBe('light');
    expect(themeAt(day, at('18:59'))).toBe('light');
    expect(themeAt(day, at('19:00'))).toBe('dark');
  });

  it('runs either way round, wrapping past midnight', () => {
    const owl = { lightAt: '20:00', darkAt: '06:00' };
    expect(themeAt(owl, at('23:00'))).toBe('light');
    expect(themeAt(owl, at('03:00'))).toBe('light');
    expect(themeAt(owl, at('12:00'))).toBe('dark');
  });

  it('knows how long until the next switch', () => {
    const day = { lightAt: '07:00', darkAt: '19:00' };
    expect(msUntilNextChange(day, at('18:00'))).toBe(60 * 60_000);
    expect(msUntilNextChange(day, at('20:00'))).toBe(11 * 60 * 60_000);
  });
});
