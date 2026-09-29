import { useState, type ReactNode } from 'react';
import './SettingRow.css';

/**
 * One setting as it reads at rest: its name, what it is now, and one action
 * ("Edit", "Change", "Set up"). The editor opens underneath only when asked —
 * settings are shown, not left as open forms waiting for a stray keystroke.
 *
 * `children` renders the editor and gets `close`, so a successful save folds
 * the row back to its new value.
 */
export default function SettingRow({
  label, value, empty, action = 'Edit', actionDisabled, hint, children, open: controlledOpen, onOpenChange, id, extra,
}: {
  label: ReactNode;
  /** The current value; null/undefined shows `empty` instead. */
  value?: ReactNode;
  /** Shown when there is no value yet ("Not set"). */
  empty?: ReactNode;
  action?: ReactNode;
  actionDisabled?: boolean;
  hint?: ReactNode;
  children?: (close: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  /** A second, lesser action beside the main one (e.g. Rename next to Remove). */
  extra?: { action: ReactNode; children: (close: () => void) => ReactNode };
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const mainOpen = controlledOpen ?? ownOpen;
  const open = mainOpen || extraOpen;
  const setOpen = (next: boolean) => { setOwnOpen(next); onOpenChange?.(next); };
  const hasValue = value !== undefined && value !== null && value !== '';

  return (
    <div className={`setting-row${open ? ' is-open' : ''}`} id={id}>
      <div className="setting-row__line">
        <div className="setting-row__text">
          <span className="setting-row__label">{label}</span>
          <span className={`setting-row__value${hasValue ? '' : ' is-empty'}`}>{hasValue ? value : (empty ?? 'Not set')}</span>
          {hint && !open && <span className="setting-row__hint">{hint}</span>}
        </div>
        {extra && !open && (
          <button type="button" className="setting-row__action" onClick={() => setExtraOpen(true)}>
            {extra.action}
          </button>
        )}
        {children && !open && (
          <button type="button" className="setting-row__action" disabled={actionDisabled} onClick={() => setOpen(true)}>
            {action}
          </button>
        )}
      </div>
      {extra && extraOpen && <div className="setting-row__editor">{extra.children(() => setExtraOpen(false))}</div>}
      {children && mainOpen && <div className="setting-row__editor">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** A titled group of rows, like a card in a settings app. */
export function SettingGroup({ title, id, children, footer }: { title: ReactNode; id?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="setting-group" aria-labelledby={id}>
      <h2 id={id} className="settings__subhead">{title}</h2>
      <div className="setting-group__rows">{children}</div>
      {footer && <div className="setting-group__footer">{footer}</div>}
    </section>
  );
}
