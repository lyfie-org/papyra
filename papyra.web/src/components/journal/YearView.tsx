import { Link } from 'react-router-dom';
import { dayOf, daysInMonth, longDate, monthGrid, monthTitle, weekdayName } from '../../lib/journalDay';
import { moodLabel } from '../../lib/journalMood';
import type { JournalSummary } from '../../types/journal';
import './YearView.css';

/**
 * A year at a glance: twelve small months, each day a square — washed with its
 * mood where it has one, filled where it has writing, empty where it doesn't.
 * A month's name opens that month; a square opens that day.
 */
export default function YearView({ year, entries, today, monthHref }: {
  year: number; entries: readonly JournalSummary[]; today: string; monthHref: (month: string) => string;
}) {
  const byDay = new Map(entries.map((e) => [e.date, e]));
  return (
    <div className="year-view">
      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
        const first = dayOf(year, m, 1);
        const written = Array.from({ length: daysInMonth(year, m) }, (_, d) => byDay.get(dayOf(year, m, d + 1))).filter((e) => e && !e.trashed).length;
        return (
          <section key={m} className="year-view__month" aria-label={`${monthTitle(first)}, ${written} ${written === 1 ? 'day' : 'days'} written`}>
            <h3 className="year-view__title"><Link to={monthHref(first.slice(0, 7))}>{monthTitle(first).replace(/\s\d{4}$/, '')}</Link></h3>
            <div className="year-view__grid">
              {monthGrid(year, m, 1).flat().map((day, i) => {
                if (!day) return <span key={i} className="year-view__pad" />;
                const e = byDay.get(day);
                const label = `${weekdayName(day)} ${longDate(day)}${e?.mood ? `, felt ${moodLabel(e.mood).toLowerCase()}` : ''}${e && !e.trashed ? (e.locked ? ', locked' : `, ${e.words} words`) : ''}`;
                const cls = `year-view__day${e?.mood ? ` year-view__day--mood-${e.mood}` : ''}${e && !e.mood && !e.trashed ? ' year-view__day--written' : ''}${day === today ? ' year-view__day--today' : ''}${day > today ? ' year-view__day--future' : ''}`;
                return day > today
                  ? <span key={i} className={cls} aria-hidden="true" />
                  : <Link key={i} to={`/journal/${day}`} className={cls} aria-label={label} title={label} />;
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
