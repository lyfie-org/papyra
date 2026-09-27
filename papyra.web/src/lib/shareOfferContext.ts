import { createContext, useContext } from 'react';

export interface ShareOffer {
  /** People just mentioned who can't open the note yet. */
  names: string[];
  noteTitle: string;
}

/** The author's answer: the role to share at, or null for "Don't share". */
export type ShareOfferAnswer = { access: 'view' | 'edit' } | null;

export type OfferShare = (offer: ShareOffer) => Promise<ShareOfferAnswer>;

export const ShareOfferContext = createContext<OfferShare | null>(null);

/** Ask the author whether to share a note with the people they just mentioned. */
export function useShareOffer(): OfferShare {
  const ctx = useContext(ShareOfferContext);
  // Outside the provider nothing is shared — declining is the safe answer.
  return ctx ?? (async () => null);
}
