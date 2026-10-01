// Two things the selection menus (luthor's formatting bubble, the Comment
// button) need from the page, installed once at startup:
//
// 1. While the mouse is still down in an editor — mid-drag, the selection not
//    finished — <html> carries `is-mouse-selecting`, and index.css keeps the
//    menus out of sight until the button comes up. Only presses that start in
//    editable text count: a press on a menu's own button must still click it.
//
// 2. On a phone the menus dock to the bottom of the screen (index.css), clear
//    of the system's copy/paste callout by the selection. `--keyboard-inset`
//    lifts them above the on-screen keyboard, which only shrinks the visual
//    viewport, so a plain `bottom: 0` would sit behind it.

const SELECTING = 'is-mouse-selecting';

export function installSelectionGuards() {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;

  const release = () => root.classList.remove(SELECTING);
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest?.('[contenteditable="true"]')) root.classList.add(SELECTING);
  }, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);

  const vv = window.visualViewport;
  if (!vv) return;
  const place = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
  };
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
  place();
}
