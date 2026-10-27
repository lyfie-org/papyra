import { Flame } from 'lucide-react';
import type { JournalPrefs, JournalStats } from '../../types/journal';
import './StreakCard.css';

/** "1,204" — grouped the way the reader's locale does. */
const num = (n: number) => n.toLocaleString();

/**
 * The streak and the totals. A day left unwritten never reads as failure: with
 * today still open the streak is shown as alive through yesterday ("keep it
 * alive"), and a streak that did end simply says how long it was. People who find
 * a streak a burden can hide it (Settings → Journal); the totals stay.
 */
export default function StreakCard({ stats, prefs }: { stats: JournalStats; prefs?: Pick<JournalPrefs, 'hideStreak'> }) {
  const hidden = prefs?.hideStreak;
  const line = hidden ? null
    : stats.todayWritten ? (stats.current > 1 ? `${stats.current} days in a row` : 'Today is written')
      : stats.current > 0 ? `${stats.current} ${stats.current === 1 ? 'day' : 'days'} so far — today keeps it alive`
        : stats.longest > 0 ? `Your longest run was ${stats.longest} ${stats.longest === 1 ? 'day' : 'days'}` : 'Write today to begin';
  return (
    <section className="streak-card" aria-label="Streak and totals">
      {line && (
        <p className="streak-card__line"><Flame size={16} aria-hidden="true" /> {line}</p>
      )}
      <dl className="streak-card__stats">
        {!hidden && (<div><dt>Longest run</dt><dd>{num(stats.longest)}</dd></div>)}
        <div><dt>Days written</dt><dd>{num(stats.totalDays)}</dd></div>
        <div><dt>This month</dt><dd>{num(stats.thisMonth)}</dd></div>
        <div><dt>Words</dt><dd>{num(stats.totalWords)}</dd></div>
      </dl>
    </section>
  );
}
