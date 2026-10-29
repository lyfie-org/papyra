import { useCallback } from 'react';
import { useLocal, writeLocal } from '../lib/localStore';

const keyOf = (name: string) => `papyra-collapsed:${name}`;

/** Whether a section is folded away, remembered on this device. `name` is e.g. `notes:pinned`. */
export function useCollapsed(name: string): [collapsed: boolean, toggle: () => void, set: (next: boolean) => void] {
  const collapsed = useLocal(keyOf(name)) === '1';
  const set = useCallback((next: boolean) => writeLocal(keyOf(name), next ? '1' : null), [name]);
  const toggle = useCallback(() => set(!collapsed), [set, collapsed]);
  return [collapsed, toggle, set];
}
