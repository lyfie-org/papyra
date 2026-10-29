/**
 * A click on the paper outside the writing — the margins beside it, the gap above it, the empty space under
 * the last line — puts the caret where the writing is nearest to that point, as clicking beside a line of a
 * text file does.
 */

/** `n` held to `[min, max]`. */
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/** The point on (just inside) `rect` nearest to (x, y). */
export function nearestPointIn(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number) {
  return { x: clamp(x, rect.left + 1, Math.max(rect.left + 1, rect.right - 1)), y: clamp(y, rect.top + 1, Math.max(rect.top + 1, rect.bottom - 1)) };
}

/** What a click may not take over: controls, links, the editor's own bars, and anything the person is selecting. */
const KEEPS_ITS_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"], [role="radio"], [role="menu"], [role="dialog"], [role="listbox"], .luthor-media__toolbar, .luthor-toolbar, [contenteditable="true"]';

/**
 * Place the caret in `editable` at the spot nearest to a click on `target` at (x, y), and focus it. Returns
 * whether it did — it leaves alone a click on a control, a click already inside the writing, and a click that
 * ended a text selection.
 */
export function placeCaretNear(editable: HTMLElement, target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element) || !editable.isContentEditable) return false;
  if (editable.contains(target) || target.closest(KEEPS_ITS_CLICK)) return false;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return false;

  const at = nearestPointIn(editable.getBoundingClientRect(), x, y);
  const doc = editable.ownerDocument;
  let range: Range | null = null;
  const caret = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(at.x, at.y);
  if (caret && editable.contains(caret.offsetNode)) {
    range = doc.createRange();
    range.setStart(caret.offsetNode, caret.offset);
  } else {
    const legacy = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(at.x, at.y);
    if (legacy && editable.contains(legacy.startContainer)) range = legacy;
  }
  editable.focus({ preventScroll: true });
  if (!range) {
    // Nothing under the point (a gap between blocks): the nearest end of the writing.
    range = doc.createRange();
    range.selectNodeContents(editable);
    range.collapse(y < editable.getBoundingClientRect().top + editable.getBoundingClientRect().height / 2);
  }
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}
