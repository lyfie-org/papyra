import { useEffect, useRef, useState } from 'react';
import type { Mood } from '../../types/journal';
import { MOODS } from '../../lib/journalMood';
import './MoodPicker.css';

const CLOUD = 'M7 17.5h9.2a3.8 3.8 0 0 0 .5-7.57A5.2 5.2 0 0 0 6.6 9.3 4.1 4.1 0 0 0 7 17.5Z';

/**
 * One day's weather. The *shape* says how it went — storm, rain, cloud, sun
 * through cloud, sun — so the value never rides on colour alone; the colour
 * (`--mood-n`) only echoes it. Drawn with the page's ink (`currentColor`
 * unless `tone`), 1.6 strokes, round caps: a margin doodle, not an icon set.
 */
export function MoodGlyph({ mood, size = 22, tone = true }: { mood: Mood; size?: number; tone?: boolean }) {
  return (
    <svg
      className={`mood-glyph${tone ? ` mood-glyph--${mood}` : ''}`}
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {mood === 1 && (<>
        <path d={CLOUD} />
        <path d="m12.6 12.6-2 3.2h2.6l-1.6 3.1" />
      </>)}
      {mood === 2 && (<>
        <path d={CLOUD} />
        <path d="M9 20l-.6 1.4M12.5 20l-.6 1.4M16 20l-.6 1.4" />
      </>)}
      {mood === 3 && (
        <path d="M6.5 18h10.4a4.2 4.2 0 0 0 .55-8.37A5.6 5.6 0 0 0 6.7 8.9 4.6 4.6 0 0 0 6.5 18Z" />
      )}
      {mood === 4 && (<>
        <circle cx="9" cy="9" r="3.2" />
        <path d="M9 3v1.2M3.2 9H4.4M4.9 4.9l.9.9M13.1 4.9l-.9.9" />
        <path d="M9.5 20h8.4a3.4 3.4 0 0 0 .45-6.77A4.6 4.6 0 0 0 9.9 13.1 3.5 3.5 0 0 0 9.5 20Z" />
      </>)}
      {mood === 5 && (<>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
      </>)}
    </svg>
  );
}

interface Props {
  value: Mood | null;
  onChange: (mood: Mood | null) => void;
  disabled?: boolean;
  /** Smaller glyphs with no word under them — for a tight header. */
  compact?: boolean;
  /**
   * Once a mood is chosen the five fold away into one small chip (the glyph and its word);
   * tapping it opens the five again. Until then the five are all there is, with a quiet prompt.
   */
  collapsible?: boolean;
}

/**
 * How the day felt: five glyphs, one tap. Tapping the chosen one again clears
 * it. A radio group for assistive tech — "Mood: Good" — with the arrow keys
 * moving between the five.
 */
export default function MoodPicker({ value, onChange, disabled, compact, collapsible }: Props) {
  // Open only because someone asked: a day with no mood always shows the five.
  const [asked, setAsked] = useState(false);
  const folded = !!collapsible && value !== null && !asked;
  const group = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);

  // Opening the five hands focus to the chosen one; folding them hands it back to the chip.
  useEffect(() => {
    if (!collapsible) return;
    if (asked) { reopened.current = true; group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }
    else if (reopened.current) { reopened.current = false; chip.current?.focus(); }
  }, [asked, collapsible]);

  function choose(next: Mood | null) {
    onChange(next);
    setAsked(false);
  }

  if (folded) {
    const label = MOODS.find((m) => m.value === value)?.label ?? '';
    return (
      <button
        ref={chip}
        type="button"
        className="mood-chip"
        disabled={disabled}
        aria-expanded={false}
        aria-label={`How the day felt: ${label}. Change`}
        title="Change how the day felt"
        onClick={() => setAsked(true)}
      >
        <MoodGlyph mood={value} size={18} />
        <span className="mood-chip__label">{label}</span>
      </button>
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (e.key === 'Escape' && collapsible && asked) { e.stopPropagation(); setAsked(false); return; }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (((value ?? (step > 0 ? 0 : 6)) - 1 + step + 5) % 5) + 1;
    onChange(next as Mood);
  }

  return (
    <div className={`mood-picker-wrap${collapsible ? ' mood-picker-wrap--collapsible' : ''}`}>
      {collapsible && value === null && <span className="mood-picker__prompt" aria-hidden="true">How was the day?</span>}
      <div
        ref={group}
        className={`mood-picker${compact ? ' mood-picker--compact' : ''}`}
        role="radiogroup"
        aria-label="How the day felt"
        onKeyDown={onKeyDown}
        onBlur={(e) => { if (asked && !e.currentTarget.contains(e.relatedTarget as Node | null)) setAsked(false); }}
      >
        {MOODS.map(({ value: v, label }) => {
          const on = value === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label}
              title={on ? `${label} — tap to clear` : label}
              tabIndex={on || (value === null && v === 3) ? 0 : -1}
              disabled={disabled}
              className={`mood-picker__btn${on ? ' mood-picker__btn--on' : ''}`}
              onClick={() => choose(on ? null : v)}
            >
              <MoodGlyph mood={v} size={compact ? 20 : 24} />
              {!compact && <span className="mood-picker__label">{label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
