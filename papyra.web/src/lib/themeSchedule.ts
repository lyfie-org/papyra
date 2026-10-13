// A time-based theme: light from one time of day, dark from another, by this
// device's clock. Kept on the account in the same `theme` field as the plain
// choices, as `schedule:07:00-19:00` (light-from, dark-from) — mirrored by the
// API's ThemeChoice and the anti-flash script in index.html.

export interface ThemeSchedule {
  /** "HH:MM" light starts. */
  lightAt: string;
  /** "HH:MM" dark starts. */
  darkAt: string;
}

export const DEFAULT_SCHEDULE: ThemeSchedule = { lightAt: '07:00', darkAt: '19:00' };

const WIRE = /^schedule:([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: string): boolean {
  return TIME.test(value);
}

/** The schedule a stored theme names, or null when it isn't one. */
export function parseSchedule(wire: string | null | undefined): ThemeSchedule | null {
  const m = wire ? WIRE.exec(wire) : null;
  if (!m) return null;
  const schedule = { lightAt: `${m[1]}:${m[2]}`, darkAt: `${m[3]}:${m[4]}` };
  return schedule.lightAt === schedule.darkAt ? null : schedule;
}

export function serializeSchedule(s: ThemeSchedule): string {
  return `schedule:${s.lightAt}-${s.darkAt}`;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Light or dark at `now`. Light runs from lightAt up to darkAt, wrapping past midnight. */
export function themeAt(s: ThemeSchedule, now: Date): 'light' | 'dark' {
  const t = now.getHours() * 60 + now.getMinutes();
  const light = minutes(s.lightAt);
  const dark = minutes(s.darkAt);
  const inLight = light < dark ? t >= light && t < dark : t >= light || t < dark;
  return inLight ? 'light' : 'dark';
}

/** Milliseconds from `now` until the schedule next switches. */
export function msUntilNextChange(s: ThemeSchedule, now: Date): number {
  const t = now.getHours() * 60 + now.getMinutes();
  const next = themeAt(s, now) === 'light' ? minutes(s.darkAt) : minutes(s.lightAt);
  const wait = (next - t + 24 * 60) % (24 * 60) || 24 * 60;
  return wait * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
}
