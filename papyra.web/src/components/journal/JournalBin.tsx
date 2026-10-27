import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Lock } from 'lucide-react';
import { JOURNAL_KEY, useJournalBin } from '../../hooks/useJournal';
import { restoreDay } from '../../lib/journalApi';
import { erasedIn, longDate } from '../../lib/journalDay';
import { useToast } from '../../lib/toastContext';
import BusyButton from '../BusyButton';
import './JournalBin.css';

/**
 * The journal's own section on the Archive and Trash pages: days put away, with the
 * way back. They are not mixed in with the notes; a day is a date, not a card.
 * Renders nothing at all when there is nothing here.
 */
export default function JournalBin({ state, retentionDays }: { state: 'archived' | 'trashed'; retentionDays?: number }) {
  const bin = useJournalBin(state);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const days = bin.data ?? [];
  if (days.length === 0) return null;
  const now = new Date();

  async function restore(date: string) {
    try {
      await restoreDay(date, state);
      void queryClient.invalidateQueries({ queryKey: JOURNAL_KEY });
      toast(`${longDate(date)} is back in the journal.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t restore that day.');
    }
  }

  return (
    <section className="journal-bin" aria-labelledby={`journal-bin-${state}`}>
      <h2 id={`journal-bin-${state}`} className="journal-bin__title"><BookOpen size={16} aria-hidden="true" /> Journal</h2>
      <ul className="journal-bin__list">
        {days.map((day) => {
          const note = state === 'trashed' ? erasedIn(day.trashedAt, retentionDays, now) : null;
          return (
            <li key={day.date} className="journal-bin__row">
              <Link className="journal-bin__date" to={`/journal/${day.date}`}>{longDate(day.date)}</Link>
              <span className="journal-bin__meta">
                {day.locked
                  ? <><Lock size={12} aria-hidden="true" /> Locked</>
                  : `${day.words} ${day.words === 1 ? 'word' : 'words'}`}
                {note && <> · {note}</>}
              </span>
              <BusyButton type="button" className="journal-bin__restore" busyLabel="Restoring…" onClick={() => restore(day.date)}>
                Restore
              </BusyButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
