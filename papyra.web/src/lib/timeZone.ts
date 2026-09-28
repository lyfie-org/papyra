import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';

/** Every IANA zone this browser knows, for the Profile picker. */
export function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** A zone the browser can actually format in, else null. */
function usable(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * The zone to show times in: the person's choice (Settings → Profile), else the
 * server's own (the container's TZ), else this browser's.
 */
export function useTimeZone(): string {
  const { user } = useAuth();
  return usable(user?.timeZone) ?? usable(user?.serverTimeZone) ?? browserTimeZone();
}

/** Re-render once a minute, so "just now" doesn't stay "just now". */
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function dayKey(d: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * "Edited just now" / "Edited 3:42 PM" / "Edited yesterday, 3:42 PM" /
 * "Edited 12 Sep, 3:42 PM" / "Edited 12 Sep 2025" — read in `zone`.
 */
export function editedLabel(iso: string, zone: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ago = now - d.getTime();
  if (ago >= 0 && ago < 60_000) return 'Edited just now';
  const time = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
  const today = dayKey(new Date(now), zone);
  const yesterday = dayKey(new Date(now - 86_400_000), zone);
  const day = dayKey(d, zone);
  if (day === today) return `Edited ${time}`;
  if (day === yesterday) return `Edited yesterday, ${time}`;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: zone, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
  return sameYear ? `Edited ${date}, ${time}` : `Edited ${date}`;
}

/** The full stamp for a tooltip: "Sunday, 28 September 2026 at 3:42:10 PM GMT+5:30". */
export function fullStamp(iso: string, zone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone, dateStyle: 'full', timeStyle: 'long',
  }).format(d);
}

/** "today" / "yesterday" / "12 Sep" / "12 Sep 2025", reading the day in `zone`. */
export function dayLabel(iso: string, zone: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = dayKey(new Date(now), zone);
  const day = dayKey(d, zone);
  if (day === today) return 'today';
  if (day === dayKey(new Date(now - 86_400_000), zone)) return 'yesterday';
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}
