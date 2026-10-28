import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import './SectionToggle.css';

/**
 * The heading of a section that can be folded away: a button that says what is inside, how
 * much, and whether it is showing. The section's body carries the `controls` id.
 */
export default function SectionToggle({ label, count, open, onToggle, controls, icon }: {
  label: ReactNode;
  /** How many things are inside; shown beside the label, also while it is folded. */
  count?: number;
  open: boolean;
  onToggle: () => void;
  /** The id of the body this heading folds. */
  controls: string;
  icon?: ReactNode;
}) {
  return (
    <h2 className="section-toggle">
      <button type="button" className="section-toggle__btn" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle}>
        <ChevronDown size={14} aria-hidden="true" className="section-toggle__chevron" />
        {icon}
        <span>{label}</span>
        {count !== undefined && <span className="section-toggle__count">{count}</span>}
      </button>
    </h2>
  );
}
