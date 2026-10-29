import { useCallback, useEffect, useRef, useState, type CSSProperties, type TouchEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, PanelRight } from 'lucide-react';
import EntrySheet from '../components/journal/EntrySheet';
import JournalAside from '../components/journal/JournalAside';
import { createJournalBridge } from '../lib/journalBridge';
import LoadingBar from '../components/LoadingBar';
import { useJournalToday } from '../hooks/useJournal';
import { useFocus } from '../hooks/useFocus';
import { addDays, isDay, longDate, mediumDate } from '../lib/journalDay';
import './JournalPage.css';

/** `/journal` → straight into today's page. The server decides what today is. */
export function JournalHomePage() {
  const today = useJournalToday();
  if (today.data) return <Navigate to={`/journal/${today.data.date}`} replace />;
  if (today.isError) {
    return (
      <section className="journal-page">
        <p className="journal-page__status" role="alert">
          Couldn’t reach the server. <button type="button" className="journal-page__retry" onClick={() => void today.refetch()}>Try again</button>
        </p>
      </section>
    );
  }
  return (
    <section className="journal-page" aria-busy="true">
      <LoadingBar label="Opening your journal" />
    </section>
  );
}

/** `/journal/:date` — one day. */
export function JournalDayPage() {
  const { date = '' } = useParams();
  if (!isDay(date)) return <Navigate to="/journal" replace />;
  return <DayView date={date} />;
}

function DayView({ date }: { date: string }) {
  const navigate = useNavigate();
  const todayQuery = useJournalToday();
  const today = todayQuery.data?.date ?? null;
  const prefs = todayQuery.data?.settings;
  const stats = todayQuery.data?.stats;

  // Which way the page turns: forward in time slides in from the right.
  const [turn, setTurn] = useState(14);
  const lastDate = useRef(date);
  useEffect(() => {
    // The page-turn direction follows navigation; it is derived from the route, not from user input.
    if (date !== lastDate.current) setTurn(date > lastDate.current ? 14 : -14);
    lastDate.current = date;
  }, [date]);

  const [bridge] = useState(createJournalBridge);
  // Notes and to-dos to link sit behind a button: the page is for writing until they are asked for.
  const [asideOpen, setAsideOpen] = useState(false);
  // Focus mode belongs to this page: leaving it (Back, the sidebar) leaves focus too.
  const { focus, exit: exitFocus } = useFocus();
  useEffect(() => exitFocus, [exitFocus]);
  const go = useCallback((to: string) => navigate(`/journal/${to}`), [navigate]);
  const canNext = today === null || date < today;

  // Alt+Shift+←/→ for the neighbouring days, Alt+T for today. (Alt+←/→ alone is the
  // browser's own Back/Forward; leave it be.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); go(addDays(date, -1)); }
      else if (e.shiftKey && e.key === 'ArrowRight' && canNext) { e.preventDefault(); go(addDays(date, 1)); }
      else if (!e.shiftKey && e.code === 'KeyT' && today) { e.preventDefault(); go(today); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [date, today, canNext, go]);

  // A swipe turns the page — but never one that starts in the writing, where it
  // means "select text".
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    const inCanvas = (e.target as HTMLElement).closest('.journal-sheet__canvas, .journal-sheet__foot, button, input');
    swipe.current = inCanvas ? null : { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (dx > 0) go(addDays(date, -1));
    else if (canNext) go(addDays(date, 1));
  };

  const streakLine = (() => {
    if (!stats || prefs?.hideStreak || date !== today) return null;
    if (stats.todayWritten) return stats.current > 1 ? `Day ${stats.current} of your streak` : null;
    return stats.current > 0 ? `${stats.current}-day streak — today keeps it alive` : null;
  })();

  return (
    <section
      className={`journal-page${asideOpen ? ' journal-page--aside' : ''}${focus ? ' journal-page--focus' : ''}`}
      style={{ '--journal-turn': `${turn}px` } as CSSProperties}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <nav className="journal-page__bar" aria-label="Journal days">
        <button type="button" className="journal-page__nav" onClick={() => go(addDays(date, -1))} aria-label="Previous day" title="Previous day (Alt+Shift+←)">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <Link
          to={`/journal/calendar?m=${date.slice(0, 7)}`}
          className="journal-page__date"
          title="Open the calendar"
          aria-label={`${longDate(date)} — open the calendar`}
        >
          <CalendarDays size={15} aria-hidden="true" /> {mediumDate(date)}
        </Link>
        <button type="button" className="journal-page__nav" onClick={() => go(addDays(date, 1))} disabled={!canNext} aria-label="Next day" title="Next day (Alt+Shift+→)">
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        {today && date !== today && (
          <button type="button" className="journal-page__today" onClick={() => go(today)} title="Back to today (Alt+T)">Today</button>
        )}
        <button
          type="button"
          className="journal-page__links"
          aria-pressed={asideOpen}
          aria-controls={asideOpen ? 'journal-aside' : undefined}
          onClick={() => setAsideOpen((o) => !o)}
          title="Notes and to-dos to link, and this day in earlier years"
        >
          <PanelRight size={16} aria-hidden="true" /> Notes &amp; to-dos
        </button>
      </nav>

      <div className="journal-page__layout">
        <div className="journal-page__main">
          <EntrySheet key={date} date={date} streakLine={streakLine} bridge={bridge} />
        </div>
        {asideOpen && <JournalAside bridge={bridge} date={date} writable={!today || date <= today} />}
      </div>
    </section>
  );
}
