import { createContext, useContext } from 'react';

// Distraction-free "focus mode" state, shared between the SignalR bridge and the
// editor. While focus is on, incoming note events are BUFFERED (counted) instead of
// invalidating the notes query — so a remote sync never re-hydrates the grid and
// disturbs the writer mid-sentence. Exiting focus flushes the buffer.
export interface FocusApi {
  focus: boolean;
  pending: number;
  enter: () => void;
  exit: () => void;
  flush: () => void;            // apply buffered updates now, staying in focus
  onExternalUpdate: () => void; // called by the hub bridge on a note event
}

// The context + hook live apart from <FocusProvider/> so this module exports no
// components — that keeps React Fast Refresh working for the provider file
// (react-refresh/only-export-components).
export const FocusContext = createContext<FocusApi | null>(null);

export function useFocus(): FocusApi {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error('useFocus must be used within a FocusProvider');
  return ctx;
}
