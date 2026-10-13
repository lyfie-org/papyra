import { beginTask, type Task } from './progress';

/** Back from the picker this long with no file yet: say the browser is still fetching it. */
const PENDING_AFTER_MS = 150;
/** No answer at all (a browser without the `cancel` event, after a cancel): stop waiting. */
const GIVE_UP_MS = 5 * 60_000;
const PICKING_CLASS = 'is-picking-file';
const BACK = ['focus', 'pointermove', 'wheel', 'keydown'] as const;

/**
 * A one-shot file picker; resolves to null when dismissed.
 *
 * Two things the page does while the browser's file dialog is up, and until
 * the chosen file has actually been handed over:
 *
 * - The pointer is the plain "working" arrow (html.is-picking-file). Papyra
 *   draws its own I-beam on coloured notes in dark mode, and Chromium on
 *   Windows can lose a drawn cursor across a native dialog — the pointer went
 *   invisible over the note until something changed its shape.
 * - Once the person is back on the page (the window regains focus, or the
 *   mouse, wheel or keyboard reaches it — none can while the dialog is open)
 *   and the file still hasn't come, the top progress bar runs. The browser can
 *   take seconds to hand a file over, and the page hears nothing until it has.
 */
export function pickFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    let task: Task | null = null;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const root = document.documentElement;

    const onBack = () => {
      for (const type of BACK) window.removeEventListener(type, onBack, true);
      pending = setTimeout(() => {
        if (!settled) task = beginTask();
      }, PENDING_AFTER_MS);
    };
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      for (const type of BACK) window.removeEventListener(type, onBack, true);
      clearTimeout(pending);
      clearTimeout(giveUp);
      task?.end();
      root.classList.remove(PICKING_CLASS);
      input.remove();
      resolve(file);
    };
    const giveUp = setTimeout(() => settle(null), GIVE_UP_MS);
    input.addEventListener('change', () => settle(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => settle(null));
    document.body.appendChild(input);
    root.classList.add(PICKING_CLASS);
    input.click();
    // After the click: the press that opened the picker is still settling.
    setTimeout(() => {
      if (!settled) for (const type of BACK) window.addEventListener(type, onBack, true);
    }, 0);
  });
}
