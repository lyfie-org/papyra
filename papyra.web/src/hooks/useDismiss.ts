import { useEffect, type RefObject } from 'react';

/**
 * Close a popover when the person clicks (or taps) anywhere outside it, or
 * presses Escape. `ref` wraps the popover and its trigger, so the trigger's own
 * click still toggles it. Escape is claimed (preventDefault) so a surrounding
 * modal that also closes on Escape stays open — that press was for the popover.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    // Capture: a click that lands on something that stops propagation (a card,
    // the editor) still counts as "outside".
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}
