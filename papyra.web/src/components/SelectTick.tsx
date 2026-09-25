import { Check } from 'lucide-react';
import './Selection.css';

/**
 * The round tick in a card's top-left corner. Clicking it starts (or extends)
 * a selection; shift-click selects the run from the last card clicked. It never
 * starts a drag.
 */
export default function SelectTick({ title, selected, selecting, onToggle }: {
  title: string;
  selected: boolean;
  selecting: boolean;
  onToggle: (shift: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="select-tick"
      aria-pressed={selected}
      aria-label={`${selected ? 'Deselect' : 'Select'} “${title}”`}
      title={selecting ? undefined : 'Select'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(e.shiftKey); }}
    >
      <Check size={14} strokeWidth={3} aria-hidden="true" />
    </button>
  );
}
