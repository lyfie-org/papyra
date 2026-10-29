import { daysInMonth, dayOf } from '../../lib/journalDay';
import { moodLabel } from '../../lib/journalMood';
import type { JournalSummary, Mood } from '../../types/journal';
import './MoodSparkline.css';

const W = 300;
const H = 72;
const PAD = 8;

/**
 * How the month went, as a line: one point per day that has a mood, higher is
 * better, with a gap where a day has none. The same weather colours as the
 * calendar mark the points; the sentence in its label is the real read.
 */
export default function MoodSparkline({ year, month, entries }: { year: number; month: number; entries: readonly JournalSummary[] }) {
  const days = daysInMonth(year, month);
  const byDay = new Map(entries.filter((e) => e.mood && !e.trashed).map((e) => [e.date, e.mood as Mood]));
  const points: { d: number; x: number; y: number; mood: Mood }[] = [];
  for (let d = 1; d <= days; d++) {
    const mood = byDay.get(dayOf(year, month, d));
    if (mood) points.push({
      d, mood,
      x: PAD + ((d - 1) / Math.max(days - 1, 1)) * (W - 2 * PAD),
      y: H - PAD - ((mood - 1) / 4) * (H - 2 * PAD),
    });
  }
  const average = points.length ? points.reduce((n, p) => n + p.mood, 0) / points.length : 0;
  const label = points.length === 0
    ? 'No moods logged this month.'
    : `Mood this month: ${points.length} ${points.length === 1 ? 'day' : 'days'} logged, mostly ${moodLabel(Math.round(average) as Mood).toLowerCase()}.`;

  return (
    <figure className="mood-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} className="mood-sparkline__mid" />
        {points.length > 1 && (
          <polyline className="mood-sparkline__line" fill="none" points={points.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
        {points.map((p) => (
          <circle key={p.d} cx={p.x} cy={p.y} r="4.2" className={`mood-sparkline__pt mood-sparkline__pt--${p.mood}`} />
        ))}
      </svg>
      <figcaption className="mood-sparkline__cap">{points.length === 0 ? 'No moods yet' : `${points.length} logged`}</figcaption>
    </figure>
  );
}
