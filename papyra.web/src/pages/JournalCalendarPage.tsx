import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react';
import MonthGrid from '../components/journal/MonthGrid';
import MoodSparkline from '../components/journal/MoodSparkline';
import OnThisDay from '../components/journal/OnThisDay';
import StreakCard from '../components/journal/StreakCard';
import YearView from '../components/journal/YearView';
import LoadingBar from '../components/LoadingBar';
import { useJournalRange, useJournalToday } from '../hooks/useJournal';
import { addMonths, dayOf, daysInMonth, monthTitle } from '../lib/journalDay';
import './JournalCalendarPage.css';

const MONTH = /^(\d{4})-(\d{2})$/;
const YEAR = /^\d{4}$/;

/** `/journal/calendar` — the month as an almanac page, or the year as twelve small ones. */
export default function JournalCalendarPage() {
  const [params, setParams] = useSearchParams();
  const today = useJournalToday();
  const todayDay = today.data?.date ?? null;

  // The URL names what's shown: ?m=2026-10 (a month) or ?y=2026 (a year); neither → this month.
  const mParam = params.get('m');
  const yParam = params.get('y');
  const yearView = !!yParam && YEAR.test(yParam);
  const monthMatch = mParam ? MONTH.exec(mParam) : null;
  const here = todayDay ?? undefined;
  const fallback = here ? here.slice(0, 7) : null;
  const monthKey = monthMatch && Number(monthMatch[2]) >= 1 && Number(monthMatch[2]) <= 12 ? mParam! : fallback;
  const year = yearView ? Number(yParam) : monthKey ? Number(monthKey.slice(0, 4)) : null;
  const month = monthKey ? Number(monthKey.slice(5, 7)) : null;

  const from = yearView && year ? dayOf(year, 1, 1) : year && month ? dayOf(year, month, 1) : '2000-01-01';
  const to = yearView && year ? dayOf(year, 12, 31) : year && month ? dayOf(year, month, daysInMonth(year, month)) : '2000-01-01';
  const range = useJournalRange(from, to);

  if (!todayDay || year === null || (!yearView && month === null)) {
    return <section className="journal-calendar" aria-busy="true"><LoadingBar label="Opening the calendar" /></section>;
  }

  const step = (delta: number) => {
    if (yearView) setParams({ y: String(year + delta) });
    else setParams({ m: addMonths(dayOf(year, month!, 1), delta).slice(0, 7) });
  };
  const title = yearView ? String(year) : monthTitle(dayOf(year, month!, 1));
  const canNext = yearView ? year < Number(todayDay.slice(0, 4)) : dayOf(year, month!, 1) < todayDay.slice(0, 7) + '-01';
  const entries = range.data?.entries ?? [];
  const stats = today.data?.stats;

  return (
    <section className="journal-calendar">
      <header className="journal-calendar__bar">
        <div className="journal-calendar__nav">
          <button type="button" className="journal-calendar__btn" onClick={() => step(-1)} aria-label={yearView ? 'Previous year' : 'Previous month'}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <h1 className="journal-calendar__title" aria-live="polite">{title}</h1>
          <button type="button" className="journal-calendar__btn" onClick={() => step(1)} disabled={!canNext} aria-label={yearView ? 'Next year' : 'Next month'}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="journal-calendar__modes" role="group" aria-label="Show">
          <button type="button" className="journal-calendar__mode" aria-pressed={!yearView}
            onClick={() => setParams({ m: `${year}-${String(month ?? Number(todayDay.slice(5, 7))).padStart(2, '0')}` })}>Month</button>
          <button type="button" className="journal-calendar__mode" aria-pressed={yearView} onClick={() => setParams({ y: String(year) })}>Year</button>
        </div>
        <Link to={`/journal/${todayDay}`} className="journal-calendar__today"><PenLine size={15} aria-hidden="true" /> Today’s page</Link>
      </header>

      <div className="journal-calendar__layout">
        <div className="journal-calendar__main" aria-busy={range.isPending}>
          {yearView
            ? <YearView year={year} entries={entries} today={todayDay} monthHref={(m) => `/journal/calendar?m=${m}`} />
            : <MonthGrid year={year} month={month!} entries={entries} today={todayDay} />}
          {range.isError && <p className="journal-calendar__error" role="alert">Couldn’t load these days. <button type="button" onClick={() => void range.refetch()}>Try again</button></p>}
        </div>
        <aside className="journal-calendar__side" aria-label="The journal at a glance">
          {stats && <StreakCard stats={stats} prefs={today.data?.settings} />}
          {!yearView && (
            <section aria-label="Mood this month" className="journal-calendar__block">
              <h2>Mood this month</h2>
              <MoodSparkline year={year} month={month!} entries={entries} />
            </section>
          )}
          <OnThisDay date={todayDay} />
        </aside>
      </div>
    </section>
  );
}
