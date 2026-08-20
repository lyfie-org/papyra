import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import './EmptyState.css';

interface Action {
  label: string;
  /** Navigate somewhere, or run something. Give one, not both. */
  to?: string;
  onClick?: () => void;
}

interface Props {
  icon: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  /** What this section is for, in a sentence or two. */
  body: string;
  /** How a thing actually gets here — the step the user is missing. */
  hint?: string;
  action?: Action;
}

/**
 * The panel a section shows when it has nothing in it.
 *
 * An empty page is the worst moment to be terse: the user is looking at a screen
 * with no content precisely because they don't yet know how to put something on
 * it. "Nothing archived." tells them the state they can already see and nothing
 * they didn't know. So every empty state here says what the section is for and
 * what to do next, in the same shape as the first-run cards.
 */
export default function EmptyState({ icon: Icon, title, body, hint, action }: Props) {
  return (
    <section className="empty-state">
      <Icon className="empty-state__icon" size={22} aria-hidden={true} />
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__body">{body}</p>
      {hint && <p className="empty-state__hint">{hint}</p>}

      {action && (action.to
        ? <Link className="empty-state__action" to={action.to}>{action.label}</Link>
        : <button type="button" className="empty-state__action" onClick={action.onClick}>{action.label}</button>
      )}
    </section>
  );
}
