// Calendar-day helpers for the journal. A journal day is a plain `yyyy-MM-dd`
// string — never a Date — so a time zone can't move it: "the 25th" is the 25th
// wherever the browser thinks it is. The server decides what *today* is
// (`GET /api/journal/today`); `todayIn` here mirrors its rule only as the
// fallback for a page opened offline, and shares test fixtures with the C#
// `JournalClock` so the two can't drift.

export type Day = string;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `yyyy-MM-dd` for a real calendar day, year 1900 or later. */
export function isDay(text: string | null | undefined): boolean {
  if (!text) return false;
  const m = DAY.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function dayOf(year: number, month: number, date: number): Day {
  return `${pad(year, 4)}-${pad(month)}-${pad(date)}`;
}

function toUtc(day: Day): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): Day {
  return dayOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(day: Day, n: number): Day {
  const date = toUtc(day);
  date.setUTCDate(date.getUTCDate() + n);
  return fromUtc(date);
}

export function addMonths(day: Day, n: number): Day {
  const [y, m, d] = day.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return dayOf(year, month, Math.min(d, daysInMonth(year, month)));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: Day): number {
  return toUtc(day).getUTCDay();
}

export function monthOf(day: Day): string {
  return day.slice(0, 7);
}

export function compareDays(a: Day, b: Day): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: Day, b: Day): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

function fmt(day: Day, options: Intl.DateTimeFormatOptions, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(toUtc(day));
}

/** "Saturday". */
export function weekdayName(day: Day, locale?: string): string {
  return fmt(day, { weekday: 'long' }, locale);
}

/** "25 October 2026" (day-month order follows the locale). */
export function longDate(day: Day, locale?: string): string {
  return fmt(day, { day: 'numeric', month: 'long', year: 'numeric' }, locale);
}

/** "27 Oct 2026" (order follows the locale). */
export function mediumDate(day: Day, locale?: string): string {
  return fmt(day, { day: 'numeric', month: 'short', year: 'numeric' }, locale);
}

/** "October 2026". */
export function monthTitle(day: Day, locale?: string): string {
  return fmt(day, { month: 'long', year: 'numeric' }, locale);
}

/** "Oct 25". */
export function shortDate(day: Day, locale?: string): string {
  return fmt(day, { day: 'numeric', month: 'short' }, locale);
}

/** "Today", "Yesterday", "Tomorrow", else the weekday. */
export function relativeName(day: Day, today: Day, locale?: string): string {
  const diff = daysBetween(today, day);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return weekdayName(day, locale);
}

/**
 * The weeks of a month for a calendar grid: each week is seven cells, `null` for
 * the padding before the 1st and after the last day.
 */
export function monthGrid(year: number, month: number, weekStartsOn = 1): (Day | null)[][] {
  const first = dayOf(year, month, 1);
  const lead = (weekday(first) - weekStartsOn + 7) % 7;
  const cells: (Day | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth(year, month); d++) cells.push(dayOf(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Day | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * The journal day of an instant in a time zone, with a day that starts
 * `dayStartsAt` hours after midnight (0–5). Mirrors the server's `JournalClock`;
 * the server is the authority, this is the offline fallback.
 */
export function todayIn(now: Date, timeZone: string | null | undefined, dayStartsAt = 0): Day {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const shifted = new Date(local - Math.min(Math.max(dayStartsAt, 0), 5) * 3_600_000);
  return fromUtc(shifted);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function matchName(word: string, names: string[]): number {
  if (word.length < 3) return -1;
  return names.findIndex((n) => n.startsWith(word));
}

/**
 * Understands what a person types after `[[` when they mean a day: "today",
 * "yesterday", "last fri", "monday", "sep 14", "14 sep", "2024-03-02". The answer
 * is the canonical `yyyy-MM-dd` (what `[[2026-09-14]]` links use), or null.
 * A weekday means its most recent occurrence strictly before today ("last fri"
 * and "fri" agree); a month-day with no year is the latest such date not after
 * today.
 */
export function parseLooseDay(text: string, today: Day): Day | null {
  const q = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  if (isDay(q)) return q;
  if (q === 'today' || q === 'now') return today;
  if (q === 'yesterday' || q === 'yday') return addDays(today, -1);

  const agoMatch = /^(\d{1,3}) days? ago$/.exec(q);
  if (agoMatch) return addDays(today, -Number(agoMatch[1]));

  const dayWord = /^(?:last |on )?([a-z]{3,9})$/.exec(q);
  if (dayWord) {
    const idx = matchName(dayWord[1], WEEKDAYS);
    if (idx >= 0) {
      let back = (weekday(today) - idx + 7) % 7;
      if (back === 0) back = 7;
      return addDays(today, -back);
    }
  }

  const [ty] = today.split('-').map(Number);
  const resolve = (month: number, date: number, year?: number): Day | null => {
    if (month < 1 || month > 12 || date < 1) return null;
    if (year !== undefined) return date <= daysInMonth(year, month) && year >= 1900 ? dayOf(year, month, date) : null;
    for (let y = ty; y > ty - 8; y--) {
      if (date > daysInMonth(y, month)) continue;
      const candidate = dayOf(y, month, date);
      if (candidate <= today) return candidate;
    }
    return null;
  };

  const monthFirst = /^([a-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(q);
  if (monthFirst) {
    const mi = matchName(monthFirst[1], MONTHS);
    if (mi >= 0) return resolve(mi + 1, Number(monthFirst[2]), monthFirst[3] ? Number(monthFirst[3]) : undefined);
  }
  const dayFirst = /^(\d{1,2}) ([a-z]{3,9})\.?(?:,? (\d{4}))?$/.exec(q);
  if (dayFirst) {
    const mi = matchName(dayFirst[2], MONTHS);
    if (mi >= 0) return resolve(mi + 1, Number(dayFirst[1]), dayFirst[3] ? Number(dayFirst[3]) : undefined);
  }
  return null;
}

/** "Midnight", "3:00 am": when a new day of the journal begins. */
export function dayStartLabel(hour: number): string {
  return hour === 0 ? 'Midnight' : `${hour}:00 am`;
}

/** "erased in 3 days": how long a trashed day is kept, or null when it is kept until the person says. */
export function erasedIn(trashedAt: string | null | undefined, retentionDays: number | undefined, now: Date): string | null {
  if (!trashedAt || retentionDays === undefined || retentionDays < 0) return null;
  const end = new Date(trashedAt).getTime() + (retentionDays + 1) * 86_400_000;
  const left = Math.ceil((end - now.getTime()) / 86_400_000);
  if (left <= 0) return 'erased soon';
  return left === 1 ? 'erased tomorrow' : `erased in ${left} days`;
}
