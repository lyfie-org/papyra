import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { longDate, weekdayName } from '../../lib/journalDay';
import { moodLabel } from '../../lib/journalMood';
import type { JournalSummary } from '../../types/journal';
import './JournalBin.css';

/** The locked days of the journal, as the Vault lists them: a date to open, never a word of the text. */
export default function LockedDays({ days }: { days: readonly JournalSummary[] }) {
  return (
    <ul className="journal-bin__list">
      {days.map((day) => (
        <li key={day.date} className="journal-bin__row">
          <Link className="journal-bin__date" to={`/journal/${day.date}`}>{weekdayName(day.date)}, {longDate(day.date)}</Link>
          <span className="journal-bin__meta">
            <Lock size={12} aria-hidden="true" /> Locked{day.mood ? <> · {moodLabel(day.mood)}</> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
