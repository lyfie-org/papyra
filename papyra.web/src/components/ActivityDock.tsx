import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { getActivity, subscribeActivity } from '../lib/progress';
import { stepCards, type Card } from '../lib/activityCards';
import './ActivityDock.css';

/**
 * Named work in progress — a backup, a restore, a job, a download — as a card
 * in the corner with a real progress bar, so it is seen wherever the person is
 * on the page. The top line still marks every bit of activity; this is for the
 * things worth naming (see `track(work, label)`, `useBusy(label)`,
 * `useActivityTask`).
 */
export default function ActivityDock() {
  const [cards, setCards] = useState<Card[]>([]);
  const showing = useRef(0);
  useEffect(() => { showing.current = cards.length; }, [cards]);

  useEffect(() => {
    // Cards appear after a delay and leave after a minimum time, which no
    // activity event marks: a clock runs while anything is open or showing.
    let clock: ReturnType<typeof setInterval> | null = null;
    const reconcile = () => {
      const open = getActivity().labelled;
      setCards((prev) => stepCards(prev, open, Date.now()));
      if (open.length === 0 && showing.current === 0 && clock) {
        clearInterval(clock);
        clock = null;
      } else if ((open.length > 0 || showing.current > 0) && !clock) {
        clock = setInterval(reconcile, 150);
      }
    };
    reconcile();
    const unsubscribe = subscribeActivity(reconcile);
    return () => {
      unsubscribe();
      if (clock) clearInterval(clock);
    };
  }, []);

  if (cards.length === 0) return null;

  return (
    <div className="activity-dock" role="status" aria-live="polite">
      {cards.map((card) => {
        const done = card.endedAt !== null;
        const pct = done ? 100 : card.progress === null ? null : Math.round(card.progress * 100);
        return (
          <div key={card.id} className={`activity-dock__card${done ? ' is-done' : ''}`}>
            <div className="activity-dock__row">
              {done
                ? <Check className="activity-dock__icon" size={16} aria-hidden="true" />
                : <Loader2 className="activity-dock__icon activity-dock__spin" size={16} aria-hidden="true" />}
              <span className="activity-dock__label">{card.label}</span>
              {pct !== null && <span className="activity-dock__pct">{pct}%</span>}
            </div>
            <span
              className={`activity-dock__bar${pct === null ? '' : ' activity-dock__bar--known'}`}
              role="progressbar"
              aria-label={card.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              style={pct === null ? undefined : { '--dock-frac': pct / 100 } as CSSProperties}
            />
          </div>
        );
      })}
    </div>
  );
}
