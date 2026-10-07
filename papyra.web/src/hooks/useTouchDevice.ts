import { useSyncExternalStore } from 'react';

// The primary pointer is a finger: phones and tablets, the installed PWA among
// them. A laptop with a touchscreen still reports a mouse/trackpad as primary.
const COARSE = '(pointer: coarse)';

/** True when the device is driven by touch — no hover, no precise drag. */
export function useTouchDevice(): boolean {
  return useSyncExternalStore(
    notify => {
      const mq = window.matchMedia?.(COARSE);
      mq?.addEventListener('change', notify);
      return () => mq?.removeEventListener('change', notify);
    },
    () => window.matchMedia?.(COARSE).matches ?? false,
    () => false,
  );
}
