import { createContext, useContext } from 'react';

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Names the action, not "OK" — the button should read as the thing it does. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Red treatment for anything unrecoverable. */
  destructive?: boolean;
}

export type Ask = (request: ConfirmRequest) => Promise<boolean>;

export const ConfirmContext = createContext<Ask | null>(null);

/** Ask the user to confirm something genuinely destructive. */
export function useConfirm(): Ask {
  const ctx = useContext(ConfirmContext);
  // Outside the provider (tests, isolated renders) nothing is destroyed by
  // default — refusing is the safe answer.
  return ctx ?? (async () => false);
}
