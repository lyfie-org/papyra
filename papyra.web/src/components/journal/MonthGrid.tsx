import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { OWN_MEDIA } from '../../lib/papyraEditorAdapter';
import { mediaUrl } from '../../lib/mediaMeta';
import { addDays, longDate, monthGrid, weekday, weekdayName } from '../../lib/journalDay';
import { moodLabel } from '../../lib/journalMood';
import type { JournalSummary } from '../../types/journal';
import { MoodGlyph } from './MoodPicker';
import './MonthGrid.css';

interface Props {
  year: number;
  month: number;
  entries: readonly JournalSummary[];
  today: string;
  /** 0 = Sunday … 1 = Monday (default). */
  weekStartsOn?: number;
}

function cellLabel(day: string, e: JournalSummary | undefined, today: string): string {
  const parts = [`${weekdayName(day)} ${longDate(day)}`];
  if (day === today) parts.push('today');
  if (e) {
    if (e.mood) parts.push(`felt ${moodLabel(e.mood).toLowerCase()}`);
    if (e.locked) parts.push('locked');
    else if (e.words > 0) parts.push(`${e.words} ${e.words === 1 ? 'word' : 'words'}`);
    if (e.archived) parts.push('archived');
    if (e.hasMedia) parts.push('has photos');
  } else if (day <= today) {
    parts.push('nothing written');
  }
  return parts.join(', ');
}

/**
 * A month as an almanac page: numerals in the heading face, a wash of the day's
 * weather, a dot where there is writing and no mood, a lock for a sealed day, a
 * small photo for a day with one. Days that haven't begun are not links. It is a
 * real table (weekday headings, a link in each day), and the arrow keys walk the
 * days — Left/Right a day, Up/Down a week, Home/End the ends of the week.
 */
export default function MonthGrid({ year, month, entries, today, weekStartsOn = 1 }: Props) {
  const weeks = monthGrid(year, month, weekStartsOn);
  const byDay = new Map(entries.map((e) => [e.date, e]));
  const head = Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);
  const first = weeks[0].find(Boolean)!;
  // A reference Sunday for the weekday names.
  const sunday = addDays(first, -weekday(first));
  const gridRef = useRef<HTMLTableElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    const link = (e.target as HTMLElement).closest('a[data-day]') as HTMLAnchorElement | null;
    if (!link) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    let want: string | null = null;
    if (step) want = addDays(link.dataset.day!, step);
    else if (e.key === 'Home' || e.key === 'End') {
      const row = link.closest('tr')!;
      const links = [...row.querySelectorAll<HTMLAnchorElement>('a[data-day]')];
      want = (e.key === 'Home' ? links[0] : links[links.length - 1])?.dataset.day ?? null;
    }
    if (!want) return;
    const target = gridRef.current?.querySelector<HTMLAnchorElement>(`a[data-day="${want}"]`);
    if (!target) return; // another month, or a day that hasn't begun
    e.preventDefault();
    target.focus();
  }

  return (
    <table className="month-grid" ref={gridRef} onKeyDown={onKeyDown}>
      <thead>
        <tr>
          {head.map((d) => (
            <th key={d} scope="col" abbr={weekdayName(addDays(sunday, d))}>
              {weekdayName(addDays(sunday, d)).slice(0, 3)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, w) => (
          <tr key={w}>
            {week.map((day, i) => {
              if (!day) return <td key={i} className="month-grid__pad" />;
              const e = byDay.get(day);
              const future = day > today;
              const classes = [
                'month-grid__day',
                e?.mood ? `month-grid__day--mood-${e.mood}` : '',
                e && !e.mood ? 'month-grid__day--written' : '',
                e?.archived ? 'month-grid__day--archived' : '',
                e?.trashed ? 'month-grid__day--trashed' : '',
                day === today ? 'month-grid__day--today' : '',
                future ? 'month-grid__day--future' : '',
              ].filter(Boolean).join(' ');
              const num = Number(day.slice(8));
              const cover = e?.cover && !e.locked ? mediaUrl(OWN_MEDIA, e.cover, { variant: 'thumb', width: 96 }) : null;
              const inner = (
                <>
                  <span className="month-grid__num">{num}</span>
                  <span className="month-grid__marks" aria-hidden="true">
                    {e?.mood && <MoodGlyph mood={e.mood} size={14} />}
                    {e && !e.mood && !e.trashed && <span className="month-grid__dot" />}
                    {e?.locked && <Lock size={11} />}
                  </span>
                  {cover && <img className="month-grid__cover" src={cover} alt="" loading="lazy" decoding="async" />}
                </>
              );
              return (
                <td key={i}>
                  {future ? (
                    <span className={classes} aria-disabled="true" aria-label={cellLabel(day, e, today)}>{inner}</span>
                  ) : (
                    <Link to={`/journal/${day}`} data-day={day} className={classes} aria-label={cellLabel(day, e, today)}
                      aria-current={day === today ? 'date' : undefined}>{inner}</Link>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
