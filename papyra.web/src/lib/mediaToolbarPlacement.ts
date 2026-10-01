// luthor centres an attachment's toolbar on the picture. On a small picture
// near the sheet's edge that pushes half the bar off-screen, so each bar that
// appears under `root` is nudged sideways (and, if it's wider than the room
// there is, narrowed so it wraps) to stay inside the sheet and the window.

const EDGE = 8;
const SHIFT = '--media-toolbar-shift';

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
    const min = Math.max(sheet.left, 0) + EDGE;
    const max = Math.min(sheet.right, window.innerWidth) - EDGE;
    for (const bar of bars) {
      if (!watched.has(bar)) { watched.add(bar); sizes.observe(bar); }
      bar.style.removeProperty(SHIFT);
      bar.style.removeProperty('max-width');
      let rect = bar.getBoundingClientRect();
      if (rect.width > max - min) {
        bar.style.maxWidth = `${Math.max(0, max - min)}px`;
        rect = bar.getBoundingClientRect();
      }
      const shift = rect.left < min ? min - rect.left : rect.right > max ? max - rect.right : 0;
      if (shift) bar.style.setProperty(SHIFT, `${Math.round(shift)}px`);
    }
  };
  function schedule() {
    if (!frame) frame = requestAnimationFrame(place);
  }

  // A bar comes with the selection (a new node) and moves under a small
  // picture (a class change); only those are watched — never `style`, which
  // this writes itself.
  const mutations = new MutationObserver(schedule);
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    mutations.disconnect();
    sizes.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
