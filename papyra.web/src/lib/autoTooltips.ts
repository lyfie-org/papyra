// Every icon-only button gets a hover tooltip, without each one having to
// remember a `title`. On hover, a button (or link / role="button") that has an
// aria-label but no title of its own borrows the label as its title. Buttons
// that already show their label as text are skipped (the tooltip would only
// repeat it), as are ones with a tooltip of their own (`title`, or luthor's
// `data-tooltip`, or the page's own instant `data-tip`).
//
// Delegated from the document so it also covers luthor's toolbars and
// anything rendered later. The borrowed title is tagged so it can follow the
// label when that changes (Pin → Unpin) and step aside when React later sets a
// real title (e.g. the offline hint): React only touches `title` when the prop
// is present, so a borrowed one is never fought over.

const TAG = 'autoTitle';
const SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"]';

export function installAutoTooltips() {
  if (typeof document === 'undefined') return;

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>(SELECTOR);
    if (!el) return;

    const label = el.getAttribute('aria-label')?.trim() ?? '';
    const title = el.getAttribute('title');
    const borrowed = el.dataset[TAG];

    if (borrowed !== undefined) {
      // Ours, unless someone else has replaced it since.
      if (title !== borrowed) { delete el.dataset[TAG]; return; }
      if (title === label) return;
      if (!label) { el.removeAttribute('title'); delete el.dataset[TAG]; return; }
      el.title = label;
      el.dataset[TAG] = label;
      return;
    }

    if (!label || title !== null || el.hasAttribute('data-tooltip') || el.hasAttribute('data-tip')) return;
    const text = el.innerText.trim().toLowerCase();
    if (text && text === label.toLowerCase()) return;
    el.title = label;
    el.dataset[TAG] = label;
  }, { passive: true });
}
