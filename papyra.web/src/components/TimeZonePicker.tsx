import { useMemo } from 'react';
import { timeZoneGroups, zoneCity, zoneOffsetLabel } from '../lib/timeZone';
import './TimeZonePicker.css';

// Country-grouped zone picker: every option reads "Kolkata · UTC+5:30" under its
// country. A native <select>, so typing a letter jumps and keyboard and screen
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
  const groups = useMemo(() => timeZoneGroups(value || null), [value]);

  return (
    <span className="tz-picker">
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
        {groups.map(g => (
          <optgroup key={g.code || g.country} label={g.zones.length > 1 ? `${g.country} (${g.zones.length} zones)` : g.country}>
            {g.zones.map(z => (
              <option key={z.id} value={z.id}>
                {g.zones.length === 1 && g.code ? `${g.country} — ${z.city}` : z.city} · {z.offset}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </span>
  );
}
