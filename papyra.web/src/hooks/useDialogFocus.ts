import { useEffect, type RefObject } from 'react';

const TABBABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'textarea:not([disabled])',
  'select:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.offsetParent !== null);
}

/**
 * Standard modal keyboard behaviour: move focus into the dialog when it opens,
 * keep Tab inside it while it's open, and put focus back where it came from on
 * close. Without this a keyboard or screen-reader user opening a note had to tab
 * through ~190 background controls to reach the editor, and the page behind the
 * dialog stayed reachable the whole time.
 *
 * Escape is deliberately NOT handled here — each dialog already owns that key,
 * and several of them have their own precedence rules (the editor lets a
 * sub-panel or the conflict banner claim it first).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the dialog itself rather than its first control: it carries the
    // accessible name, so screen readers announce what just opened, and we don't
    // hijack the caret from an editor surface inside it.
    if (!node.contains(document.activeElement)) {
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = tabbables(node);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      // Wrap at both ends, and pull focus back in if it has escaped the dialog.
      if (!active || !node.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Only restore if focus is still ours to move — the user may have clicked
      // somewhere else entirely by the time this unmounts.
      if (previouslyFocused?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [ref]);
}
