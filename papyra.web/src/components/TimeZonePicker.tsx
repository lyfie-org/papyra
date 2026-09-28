import { useMemo, useState } from 'react';
import { timeZoneGroups, zoneCity, zoneOffsetLabel } from '../lib/timeZone';
import './TimeZonePicker.css';

// Country-grouped zone picker: every option reads "Kolkata · UTC+5:30" under its
// country, and a filter box narrows by country, city or offset ("india",
// "berlin", "+5:30"). A native <select> underneath, so keyboard and screen
// readers behave as they do everywhere else.
export default function TimeZonePicker({
  value, onChange, serverZone, allowDefault = true, invalid, describedBy, selectClassName, id,
}: {
  /** '' = follow the server's zone (only when allowDefault). */
  value: string;
  onChange: (zone: string) => void;
  serverZone?: string | null;
  allowDefault?: boolean;
  invalid?: boolean;
  describedBy?: string;
  selectClassName?: string;
  id?: string;
}) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => timeZoneGroups(value || null), [value]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase().replace('−', '-');
    if (!q) return groups;
    return groups
      .map(g => {
        if (g.country.toLowerCase().includes(q)) return g;
        const zones = g.zones.filter(z =>
          z.city.toLowerCase().includes(q)
          || z.id.toLowerCase().includes(q)
          || z.offset.toLowerCase().replace('−', '-').includes(q));
        return zones.length ? { ...g, zones } : null;
      })
      .filter((g): g is (typeof groups)[number] => g !== null);
  }, [groups, filter]);

  const selectedVisible = !value || shown.some(g => g.zones.some(z => z.id === value));
  const matches = shown.reduce((n, g) => n + g.zones.length, 0);

  return (
    <span className="tz-picker">
      <input
        type="search"
        className="tz-picker__filter"
        value={filter}
        placeholder="Filter by country, city or UTC offset"
        aria-label="Filter time zones"
        onChange={e => setFilter(e.target.value)}
      />
      <select
        id={id}
        className={selectClassName}
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={e => onChange(e.target.value)}
      >
        {allowDefault && (
          <option value="">
            Server default{serverZone ? ` (${zoneCity(serverZone)} · ${zoneOffsetLabel(serverZone)})` : ''}
          </option>
        )}
        {/* Keep the current choice selectable even when the filter hides it. */}
        {!selectedVisible && value && (
          <option value={value}>{zoneCity(value)} · {zoneOffsetLabel(value)}</option>
        )}
        {shown.map(g => (
          <optgroup key={g.code || g.country} label={g.zones.length > 1 ? `${g.country} (${g.zones.length} zones)` : g.country}>
            {g.zones.map(z => (
              <option key={z.id} value={z.id}>
                {g.zones.length === 1 && g.code ? `${g.country} — ${z.city}` : z.city} · {z.offset}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {filter.trim() && (
        <span className="tz-picker__count" role="status">
          {matches === 0 ? 'No zones match.' : `${matches} zone${matches === 1 ? '' : 's'} match.`}
        </span>
      )}
    </span>
  );
}
