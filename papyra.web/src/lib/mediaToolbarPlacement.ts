// luthor centres an attachment's toolbar on the picture. On a small picture
// near the sheet's edge that pushes half the bar off-screen, so each bar that
// appears under `root` is nudged sideways (and, if it's wider than the room
// there is, narrowed so it wraps) to stay inside the sheet and the window.
//
// And up or down: a note scrolls inside its panel, so a bar on a picture at the
// panel's foot (or one whose top has scrolled away) was cut off by the panel's
// edge. Each bar is kept inside what can actually be seen — where it is if it
// fits, else riding the visible part of its picture, else just above or below
// the picture — never under the fold.

const EDGE = 8;
const GAP = 6;
const SHIFT = '--media-toolbar-shift';
const SHIFT_Y = '--media-toolbar-shift-y';

interface Box { top: number; bottom: number; left: number; right: number }

/** The window cut down by every scrolling/clipping ancestor of `el`. */
export function visibleBox(el: Element): Box {
  const box: Box = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let node: Element | null = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const r = node.getBoundingClientRect();
    box.top = Math.max(box.top, r.top + node.clientTop);
    box.left = Math.max(box.left, r.left + node.clientLeft);
    box.right = Math.min(box.right, node.clientWidth > 0 ? r.left + node.clientLeft + node.clientWidth : r.right);
    box.bottom = Math.min(box.bottom, node.clientHeight > 0 ? r.top + node.clientTop + node.clientHeight : r.bottom);
  }
  return box;
}

/**
 * Where (viewport top) a bar of `height` should sit for a picture spanning
 * `frame`, given its natural top and the visible area.
 */
export function placeBarVertically(natural: number, height: number, frame: { top: number; bottom: number }, view: { top: number; bottom: number }): number {
  const min = view.top + EDGE;
  const max = view.bottom - EDGE - height;
  const fits = (top: number) => top >= min - 0.5 && top <= max + 0.5;
  if (fits(natural)) return natural;
  // Riding the visible part of the picture, inside it; or just past it. A bar
  // that sat outside a small picture (or card) moves to its other side before
  // it covers it; one that sat on a big picture stays on it.
  const inside = Math.min(Math.max(min, frame.top + EDGE), frame.bottom - EDGE - height);
  const above = frame.top - GAP - height;
  const below = frame.bottom + GAP;
  const candidates =
    natural >= frame.bottom - 1 ? [above, inside]
      : natural + height <= frame.top + 1 ? [below, inside]
        : [inside, above, below];
  for (const top of candidates) if (fits(top)) return top;
  return max < min ? min : Math.min(Math.max(natural, min), max);
}

export function keepMediaToolbarsInView(root: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  let frame = 0;
  const sizes = new ResizeObserver(() => schedule());
  const watched = new Set<HTMLElement>();

  const place = () => {
    frame = 0;
    const bars = root.querySelectorAll<HTMLElement>('.luthor-media__toolbar');
    for (const bar of watched) if (!bar.isConnected) { sizes.unobserve(bar); watched.delete(bar); }
    if (bars.length === 0) return;
    const sheet = root.getBoundingClientRect();
    const view = visibleBox(root);
    const min = Math.max(sheet.left, view.left) + EDGE;
    const max = Math.min(sheet.right, view.right) - EDGE;
    for (const bar of bars) {
      if (!watched.has(bar)) { watched.add(bar); sizes.observe(bar); }
      bar.style.removeProperty(SHIFT);
      bar.style.removeProperty(SHIFT_Y);
      bar.style.removeProperty('max-width');
      let rect = bar.getBoundingClientRect();
      if (rect.width > max - min) {
        bar.style.maxWidth = `${Math.max(0, max - min)}px`;
        rect = bar.getBoundingClientRect();
      }
      const shift = rect.left < min ? min - rect.left : rect.right > max ? max - rect.right : 0;
      if (shift) bar.style.setProperty(SHIFT, `${Math.round(shift)}px`);

      const media = bar.closest('.luthor-media__frame') ?? bar.parentElement;
      if (!media) continue;
      const box = media.getBoundingClientRect();
      // A picture scrolled entirely out of view takes its bar with it.
      if (box.bottom < view.top || box.top > view.bottom) continue;
      const top = placeBarVertically(rect.top, rect.height, box, view);
      const shiftY = Math.round(top - rect.top);
      if (shiftY) bar.style.setProperty(SHIFT_Y, `${shiftY}px`);
    }
  };
  function schedule() {
    if (!frame) frame = requestAnimationFrame(place);
  }

  // A bar comes with the selection (a new node) and moves under a small
  // picture (a class change); only those are watched — never `style`, which
  // this writes itself. Scrolling the note moves what can be seen.
  const mutations = new MutationObserver(schedule);
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    mutations.disconnect();
    sizes.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
  };
}
