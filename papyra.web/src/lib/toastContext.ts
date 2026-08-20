import { createContext, useContext } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastApi {
  /** Say what just happened. Returns nothing — a toast is never awaited. */
  toast: (message: string, action?: ToastAction) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  // A no-op fallback keeps components usable outside the provider (tests,
  // isolated renders) instead of throwing on an incidental dependency.
  return ctx ?? { toast: () => {} };
}
