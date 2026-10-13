import { beginTask, type Task } from './progress';

/** Back from the picker this long with no file yet: say the browser is still fetching it. */
const PENDING_AFTER_MS = 150;
/** No answer after this long (a browser without the `cancel` event, after a cancel): stop waiting. */
const GIVE_UP_MS = 60_000;
const PENDING_CLASS = 'is-picking-file';

/**
 * A one-shot file picker; resolves to null when dismissed.
 *
 * The browser can take a while to hand over a chosen file after its dialog has
 * closed — a OneDrive or iCloud file is downloaded first, a virus scanner reads
 * it — and the page hears nothing until it has. Seconds of a frozen-looking
 * page, the pointer not redrawn over it. So once the window has its focus back
 * and the file still hasn't come, the top progress bar runs and the pointer
 * shows "working" until it arrives.
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
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const root = document.documentElement;

    const onFocus = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (settled || task) return;
        task = beginTask();
        root.classList.add(PENDING_CLASS);
        giveUp = setTimeout(() => settle(null), GIVE_UP_MS);
      }, PENDING_AFTER_MS);
    };
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      clearTimeout(pending);
      clearTimeout(giveUp);
      task?.end();
      root.classList.remove(PENDING_CLASS);
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => settle(null));
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}
