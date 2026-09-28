import { useEffect, useState } from 'react';
import { ZONES_BY_COUNTRY } from './timeZoneCountries';
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

/**
 * A zone's current offset as "UTC+5:30" / "UTC−8" / "UTC". Current, because
 * daylight saving moves it: London is UTC+1 in July and UTC in January.
 */
export function zoneOffsetMinutes(zone: string, at: Date = new Date()): number {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-−])(\d{1,2})(?::(\d{2}))?/.exec(part);
    if (!m) return 0;
    const sign = m[1] === '+' ? 1 : -1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return 0;
  }
}

export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

export function zoneOffsetLabel(zone: string, at?: Date): string {
  return formatOffset(zoneOffsetMinutes(zone, at));
}

// Old names some browsers still report (Chrome lists Asia/Calcutta, not
// Asia/Kolkata): show the city as it is called today.
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'Pacific/Enderbury': 'Pacific/Kanton',
  'America/Godthab': 'America/Nuuk',
};

/** "America/Argentina/Buenos_Aires" → "Buenos Aires (Argentina)"; "Asia/Calcutta" → "Kolkata". */
export function zoneCity(zone: string): string {
  const parts = (RENAMED[zone] ?? zone).split('/').map(p => p.replace(/_/g, ' '));
  if (parts.length <= 1) return parts[0] ?? zone;
  const city = parts[parts.length - 1];
  return parts.length > 2 ? `${city} (${parts[parts.length - 2]})` : city;
}

export interface ZoneOption { id: string; city: string; offset: string; offsetMinutes: number }
export interface ZoneGroup { code: string; country: string; zones: ZoneOption[] }

/**
 * Every zone the browser knows, grouped by country (alphabetical, by the
 * country's name in this browser's language), each zone labelled with its city
 * and current UTC offset. Zones without a country (UTC, Etc/…) come last under
 * "Other". `ensure` is always included, so a saved zone the browser lists under
 * another alias (Asia/Calcutta vs Asia/Kolkata) never silently disappears.
 */
export function timeZoneGroups(ensure?: string | null, at: Date = new Date()): ZoneGroup[] {
  const supported = new Set(allTimeZones());
  if (ensure) supported.add(ensure);
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames(undefined, { type: 'region' }); } catch { /* old browser */ }

  const option = (id: string): ZoneOption => {
    const offsetMinutes = zoneOffsetMinutes(id, at);
    return { id, city: zoneCity(id), offset: formatOffset(offsetMinutes), offsetMinutes };
  };
  const byOffset = (a: ZoneOption, b: ZoneOption) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city);

  const placed = new Set<string>();
  const groups: ZoneGroup[] = [];
  for (const [code, list] of Object.entries(ZONES_BY_COUNTRY)) {
    const zones = list.filter(z => supported.has(z) && !placed.has(z));
    if (zones.length === 0) continue;
    zones.forEach(z => placed.add(z));
    groups.push({ code, country: names?.of(code) ?? code, zones: zones.map(option).sort(byOffset) });
  }
  groups.sort((a, b) => a.country.localeCompare(b.country));

  const rest = [...supported].filter(z => !placed.has(z)).map(option).sort(byOffset);
  if (rest.length) groups.push({ code: '', country: 'Other', zones: rest });
  return groups;
}
