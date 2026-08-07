import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Distraction-free "focus mode" state, shared between the SignalR bridge and the
// editor. While focus is on, incoming note events are BUFFERED (counted) instead of
// invalidating the notes query — so a remote sync never re-hydrates the grid and
// disturbs the writer mid-sentence. Exiting focus flushes the buffer.
interface FocusApi {
  focus: boolean;
  pending: number;
  enter: () => void;
  exit: () => void;
  flush: () => void;            // apply buffered updates now, staying in focus
  onExternalUpdate: () => void; // called by the hub bridge on a note event
}

const FocusContext = createContext<FocusApi | null>(null);

export function FocusProvider({ children }: { children: React.ReactNode }) {
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

export function useFocus(): FocusApi {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error('useFocus must be used within a FocusProvider');
  return ctx;
}
