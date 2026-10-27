// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MonthGrid from './MonthGrid';
import MoodSparkline from './MoodSparkline';
import StreakCard from './StreakCard';
import YearView from './YearView';
import { longDate, weekdayName } from '../../lib/journalDay';
import type { JournalStats, JournalSummary } from '../../types/journal';

// Dates read in the reader's own order ("1 October 2026" / "October 1, 2026"): build the expected text the same way.
const on = (d: string) => weekdayName(d) + ' ' + longDate(d);
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

afterEach(cleanup);

const entry = (date: string, over: Partial<JournalSummary> = {}): JournalSummary => ({
  date, mood: null, tags: [], words: 40, hasMedia: false, locked: false, archived: false, trashed: false,
  cover: null, excerpt: null, updated: '2026-10-01T00:00:00Z', ...over,
});

const grid = (entries: JournalSummary[], today = '2026-10-15') =>
  render(<MemoryRouter><MonthGrid year={2026} month={10} entries={entries} today={today} /></MemoryRouter>);

describe('MonthGrid', () => {
  it('is a table with a heading for each weekday and a day under each', () => {
    grid([]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // 1 October 2026 is a Thursday: three blanks lead the first week.
    const firstRow = screen.getAllByRole('row')[1];
    expect(within(firstRow).getAllByRole('cell').slice(0, 3).every((c) => c.textContent === '')).toBe(true);
  });

  it('links every day that has begun, and not the days that haven’t', () => {
    grid([], '2026-10-15');
    expect(screen.getByRole('link', { name: re(on('2026-10-01')) }).getAttribute('href')).toBe('/journal/2026-10-01');
    expect(screen.getByRole('link', { name: re(on('2026-10-15') + ', today') }).getAttribute('aria-current')).toBe('date');
    expect(screen.queryByRole('link', { name: re(on('2026-10-16')) })).toBeNull();
    expect(screen.getByLabelText(re(on('2026-10-16'))).getAttribute('aria-disabled')).toBe('true');
  });

  it('says what each day holds, in words — mood, size, lock, photos, archive', () => {
    grid([
      entry('2026-10-02', { mood: 4, words: 120, hasMedia: true }),
      entry('2026-10-03', { mood: 1, locked: true, words: 55 }),
      entry('2026-10-04', { archived: true, words: 1 }),
    ]);
    expect(screen.getByRole('link', { name: re(on('2026-10-02') + ', felt good, 120 words, has photos') })).toBeTruthy();
    // A locked day gives out nothing but that it is locked.
    const locked = screen.getByRole('link', { name: re(on('2026-10-03')) }).getAttribute('aria-label')!;
    expect(locked).toContain('felt rough');
    expect(locked).toContain('locked');
    expect(locked).not.toContain('55');
    expect(screen.getByRole('link', { name: re(on('2026-10-04') + ', 1 word, archived') })).toBeTruthy();
    expect(screen.getByRole('link', { name: re(on('2026-10-05') + ', nothing written') })).toBeTruthy();
  });

  it('washes a day with its mood and marks writing that has none', () => {
    const { container } = grid([entry('2026-10-02', { mood: 5 }), entry('2026-10-03')]);
    expect(container.querySelector('a[data-day="2026-10-02"]')!.className).toContain('month-grid__day--mood-5');
    expect(container.querySelector('a[data-day="2026-10-03"]')!.className).toContain('month-grid__day--written');
  });

  it('never loads a photo for a locked day', () => {
    const { container } = grid([entry('2026-10-02', { cover: 'a.jpg' }), entry('2026-10-03', { cover: 'b.jpg', locked: true })]);
    const covers = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(covers).toHaveLength(1);
    expect(covers[0]).toContain('a.jpg');
  });

  it('walks the days with the arrow keys', () => {
    const { container } = grid([]);
    const at = (d: string) => container.querySelector<HTMLAnchorElement>(`a[data-day="${d}"]`)!;
    at('2026-10-07').focus();
    fireEvent.keyDown(at('2026-10-07'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(at('2026-10-08'));
    fireEvent.keyDown(at('2026-10-08'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(at('2026-10-15'));
    fireEvent.keyDown(at('2026-10-15'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(at('2026-10-14'));
    fireEvent.keyDown(at('2026-10-14'), { key: 'Home' });
    expect(document.activeElement).toBe(at('2026-10-12')); // the Monday of that week
    // A day that hasn't begun is not a stop.
    fireEvent.keyDown(at('2026-10-15'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(at('2026-10-12'));
  });
});

describe('MoodSparkline', () => {
  it('describes the month in a sentence', () => {
    render(<MoodSparkline year={2026} month={10} entries={[entry('2026-10-01', { mood: 4 }), entry('2026-10-02', { mood: 4 }), entry('2026-10-03', { mood: 5 })]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Mood this month: 3 days logged, mostly good.');
  });

  it('says so when nothing is logged, and ignores a day in the bin', () => {
    render(<MoodSparkline year={2026} month={10} entries={[entry('2026-10-01', { mood: 4, trashed: true })]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('No moods logged this month.');
  });
});

const stats = (over: Partial<JournalStats> = {}): JournalStats => ({
  current: 0, longest: 0, totalDays: 0, totalWords: 0, thisMonth: 0, todayWritten: false, streakEndsOn: null, ...over,
});

describe('StreakCard', () => {
  it('calls an unwritten today “alive”, never a failure', () => {
    render(<StreakCard stats={stats({ current: 6, longest: 9, totalDays: 40 })} />);
    expect(screen.getByText(/6 days so far — today keeps it alive/)).toBeTruthy();
  });

  it('celebrates a written today only once it is a run', () => {
    const { rerender } = render(<StreakCard stats={stats({ current: 1, todayWritten: true })} />);
    expect(screen.getByText('Today is written')).toBeTruthy();
    rerender(<StreakCard stats={stats({ current: 5, todayWritten: true })} />);
    expect(screen.getByText('5 days in a row')).toBeTruthy();
  });

  it('after a gap, says how long the best run was; with nothing yet, invites', () => {
    const { rerender } = render(<StreakCard stats={stats({ current: 0, longest: 12, totalDays: 30 })} />);
    expect(screen.getByText('Your longest run was 12 days')).toBeTruthy();
    rerender(<StreakCard stats={stats()} />);
    expect(screen.getByText('Write today to begin')).toBeTruthy();
  });

  it('hides the streak on request but keeps the totals', () => {
    render(<StreakCard stats={stats({ current: 6, longest: 9, totalDays: 40, totalWords: 12345 })} prefs={{ hideStreak: true }} />);
    expect(screen.queryByText(/so far/)).toBeNull();
    expect(screen.queryByText('Longest run')).toBeNull();
    expect(screen.getByText('Days written')).toBeTruthy();
    expect(screen.getByText((12345).toLocaleString())).toBeTruthy();
  });
});

describe('YearView', () => {
  it('shows twelve months, each named and counted, each day a link', () => {
    render(
      <MemoryRouter>
        <YearView year={2026} today="2026-10-15" entries={[entry('2026-03-02', { mood: 3 }), entry('2026-03-03')]}
          monthHref={(m) => `/journal/calendar?m=${m}`} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(12);
    expect(screen.getByRole('region', { name: 'March 2026, 2 days written' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'March' }).getAttribute('href')).toBe('/journal/calendar?m=2026-03');
    expect(screen.getByRole('link', { name: re(on('2026-03-02') + ', felt okay') })).toBeTruthy();
    // Days after today aren't links.
    expect(screen.queryByRole('link', { name: re(on('2026-10-20')) })).toBeNull();
  });
});

describe('five years of writing', () => {
  // Every day of 2022–2026 written, each with a mood: the calendar must not slow with age.
  const days = (() => {
    const out: JournalSummary[] = [];
    for (let y = 2022; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
          out.push(entry(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, { mood: ((d + m) % 5 + 1) as 1 | 2 | 3 | 4 | 5 }));
        }
      }
    }
    return out;
  })();

  it('draws a month and a year in well under a second each, however many days are behind it', () => {
    expect(days.length).toBeGreaterThan(1800);
    const t0 = performance.now();
    const month = render(<MemoryRouter><MonthGrid year={2024} month={2} entries={days} today="2026-10-15" /></MemoryRouter>);
    const monthMs = performance.now() - t0;
    expect(within(month.container).getAllByRole('link')).toHaveLength(29); // a leap February
    month.unmount();

    const t1 = performance.now();
    const year = render(<MemoryRouter><YearView year={2024} entries={days} today="2026-10-15" monthHref={(m) => `/journal/calendar?m=${m}`} /></MemoryRouter>);
    const yearMs = performance.now() - t1;
    expect(year.container.querySelectorAll('.year-view__day--mood-1, .year-view__day--mood-2, .year-view__day--mood-3, .year-view__day--mood-4, .year-view__day--mood-5')).toHaveLength(366);
    expect(monthMs).toBeLessThan(1000);
    expect(yearMs).toBeLessThan(1500);
  });
});
