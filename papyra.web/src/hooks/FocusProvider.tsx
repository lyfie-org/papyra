import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FocusContext } from './useFocus';

export function FocusProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [focus, setFocus] = useState(false);
  const [pending, setPending] = useState(0);
  // Refs mirror state so the stable hub callback reads current values without
  // re-subscribing the connection on every change.
  const focusRef = useRef(false);
  focusRef.current = focus;
  const pendingRef = useRef(0);
  pendingRef.current = pending;

  const flush = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['notes'] });
    setPending(0);
  }, [queryClient]);

  const onExternalUpdate = useCallback(() => {
    if (focusRef.current) setPending((p) => p + 1); // buffer — don't yank the editor
    else queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [queryClient]);

  const enter = useCallback(() => setFocus(true), []);
  const exit = useCallback(() => {
    setFocus(false);
    if (pendingRef.current > 0) flush(); // apply everything buffered while focused
  }, [flush]);

  const value = useMemo(
    () => ({ focus, pending, enter, exit, flush, onExternalUpdate }),
    [focus, pending, enter, exit, flush, onExternalUpdate],
  );
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}
