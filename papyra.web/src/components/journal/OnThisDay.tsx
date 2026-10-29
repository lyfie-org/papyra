import { Link } from 'react-router-dom';
import { useOnThisDay } from '../../hooks/useJournal';
import { longDate } from '../../lib/journalDay';
import { MoodGlyph } from './MoodPicker';
import './OnThisDay.css';

/**
 * The same day in earlier years, newest first: a line or two of what you wrote
 * then. A locked day shows only that it exists — never a word of it.
 */
export default function OnThisDay({ date }: { date: string }) {
  const { data } = useOnThisDay(date);
  if (!data || data.length === 0) return null;
  return (
    <section className="on-this-day" aria-label="On this day">
      <h2 className="on-this-day__head">On this day</h2>
      <ul className="on-this-day__list">
        {data.map((e) => (
          <li key={e.date}>
            <Link to={`/journal/${e.date}`} className="on-this-day__item">
              <span className="on-this-day__year">
                {e.date.slice(0, 4)}
                {e.mood && <MoodGlyph mood={e.mood} size={14} />}
              </span>
              <span className="on-this-day__text">
                {e.locked ? 'A locked entry.' : e.excerpt || 'A day with a mood and no words.'}
              </span>
              <span className="on-this-day__sr">{longDate(e.date)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
