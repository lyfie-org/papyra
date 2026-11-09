/**
 * The rules behind the tooltip, with no React and no timers, so each can be tested on its own.
 * `components/TooltipLayer.tsx` is the one thing on screen that uses them.
 *
 * A control asks for a tooltip with an attribute:
 *
 *     <button data-tooltip="Previous day" data-tooltip-keys="Alt+Shift+←" aria-label="Previous day">
 *
 * Text the page doesn't render itself (the editor's toolbar sets a plain `title`) is picked up too, and an
 * icon-only control with just an `aria-label` borrows that as its tooltip.
 */

export interface TipContent {
  /** What it says. May hold line breaks. */
  text: string;
  /** A shortcut, one key per entry ("Alt", "Shift", "←"), drawn as keycaps. */
  keys: string[];
}

export interface Resolved {
  /** The element the tooltip belongs to. */
  host: HTMLElement;
  content: TipContent;
  /** Where the text came from. A `title` is lent to the tooltip and handed back afterwards. */
  source: 'attribute' | 'title' | 'label';
}

/** Separate "Alt+Shift+←" into keys. `⌘/Ctrl` stays one key: it names two keyboards, not two presses. */
export function parseKeys(raw: string): string[] {
  return raw.split('+').map(k => k.trim()).filter(Boolean);
}

const KEYS_AT_END = /^(.*?)\s*\(((?:(?:Ctrl|Control|Alt|Shift|Cmd|Meta|Option|⌘|⌥|⇧)(?:\/(?:Ctrl|Cmd|Control|⌘))?\+)+[^)\s]+|Esc|Escape|Enter)\)$/s;

/**
 * "Bold (Ctrl+B)" → text "Bold", keys [Ctrl, B]. Only a trailing parenthesis that is clearly a shortcut
 * is taken apart, so "Share (everyone sees it)" stays as written.
 */
export function splitShortcut(raw: string): TipContent {
  const m = KEYS_AT_END.exec(raw.trim());
  if (!m || !m[1]) return { text: raw.trim(), keys: [] };
  return { text: m[1], keys: parseKeys(m[2]) };
}

const INTERACTIVE = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="radio"], [role="switch"]';

/** Text a sighted person already reads on the control. */
function visibleText(el: HTMLElement): string {
  return (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The tooltip for what the pointer is over, looking from the element outward the way the browser's own
 * tooltips do: the nearest ancestor that has one wins.
 *
 * 1. `data-tooltip` (with an optional `data-tooltip-keys`).
 * 2. A plain `title`: the editor's, or anything we haven't converted yet.
 * 3. An icon-only control's `aria-label`. A control that already shows its label as text gets nothing,
 *    because the tooltip would only repeat it.
 */
export function resolveTip(start: Element | null): Resolved | null {
  for (let el = start; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;

    const own = el.getAttribute('data-tooltip')?.trim();
    if (own) {
      const keys = el.getAttribute('data-tooltip-keys');
      return { host: el, content: { text: own, keys: keys ? parseKeys(keys) : [] }, source: 'attribute' };
    }

    // `iframe` and `svg` use `title` as their name, not as a tooltip.
    const title = el.getAttribute('title')?.trim();
    if (title && el.tagName !== 'IFRAME') {
      return { host: el, content: splitShortcut(title), source: 'title' };
    }

    if (el.matches(INTERACTIVE)) {
      const label = el.getAttribute('aria-label')?.trim();
      if (label) {
        const shown = visibleText(el).toLowerCase();
        if (shown && shown === label.toLowerCase()) return null;
        const keys = el.getAttribute('data-tooltip-keys');
        return { host: el, content: { text: label, keys: keys ? parseKeys(keys) : [] }, source: 'label' };
      }
    }
  }
  return null;
}

/**
 * Should the tooltip also be announced as the control's description? Only when it says something the
 * name doesn't: a tooltip that repeats the name would be read out twice.
 */
export function needsDescription(host: HTMLElement, text: string): boolean {
  const same = (a: string | null | undefined) => (a ?? '').trim().toLowerCase() === text.trim().toLowerCase();
  return !same(host.getAttribute('aria-label')) && !same(visibleText(host));
}

export interface Box { x: number; y: number; width: number; height: number }
export interface Placement { x: number; y: number; side: 'top' | 'bottom' }

/**
 * Where the tooltip goes: centred under the control, or above it when there is no room below, and
 * never past the edge of the window. If neither side fits it takes the one with more room.
 */
export function place(anchor: Box, tip: { width: number; height: number }, view: { width: number; height: number }, gap = 8, margin = 8): Placement {
  const below = view.height - (anchor.y + anchor.height) - gap - margin;
  const above = anchor.y - gap - margin;
  const side: 'top' | 'bottom' = tip.height <= below ? 'bottom' : tip.height <= above ? 'top' : below >= above ? 'bottom' : 'top';

  const centre = anchor.x + anchor.width / 2 - tip.width / 2;
  const x = Math.max(margin, Math.min(centre, view.width - tip.width - margin));
  const y = side === 'bottom' ? anchor.y + anchor.height + gap : anchor.y - gap - tip.height;
  return { x, y: Math.max(margin, y), side };
}

/** How long to wait before showing, and whether to skip the wait. */
export const SHOW_DELAY_MS = 450;
/** Moving from one control to the next shortly after a tooltip closed shows the next at once. */
export const WARM_WINDOW_MS = 500;
/** Leaving the control gives the pointer this long to reach the tooltip (it can be hovered and read). */
export const HIDE_GRACE_MS = 140;

export function showDelay(now: number, lastHiddenAt: number | null): number {
  return lastHiddenAt !== null && now - lastHiddenAt < WARM_WINDOW_MS ? 0 : SHOW_DELAY_MS;
}
