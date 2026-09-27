import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Eye, PencilLine } from 'lucide-react';
import Avatar from './Avatar';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
  ShareOfferContext, type OfferShare, type ShareOffer, type ShareOfferAnswer,
} from '../lib/shareOfferContext';
import './ShareOfferDialog.css';

/**
 * "Share with @bea?" — asked the moment you mention someone who can't open the
 * note, the way Google Docs asks when you @-mention a person without access.
 *
 * Access is the whole note or nothing, so the only choices are the role (edit,
 * the default, because a mention is usually an invitation to join in; or view)
 * and whether to share at all. Mounted once for the app and awaited by the
 * caller, like ConfirmProvider.
 */
export function ShareOfferProvider({ children }: { children: ReactNode }) {
  const [offer, setOffer] = useState<ShareOffer | null>(null);
  const resolver = useRef<((answer: ShareOfferAnswer) => void) | null>(null);

  const ask = useCallback<OfferShare>((next) => {
    // A second offer while one is open (two saves in a row) answers the first
    // with "no" rather than leaving its promise hanging forever.
    resolver.current?.(null);
    setOffer(next);
    return new Promise<ShareOfferAnswer>(resolve => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((answer: ShareOfferAnswer) => {
    setOffer(null);
    resolver.current?.(answer);
    resolver.current = null;
  }, []);

  return (
    <ShareOfferContext.Provider value={ask}>
      {children}
      {offer && <ShareOfferDialog offer={offer} onAnswer={settle} />}
    </ShareOfferContext.Provider>
  );
}

function ShareOfferDialog({ offer, onAnswer }: { offer: ShareOffer; onAnswer: (a: ShareOfferAnswer) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const shareRef = useRef<HTMLButtonElement | null>(null);
  const [access, setAccess] = useState<'view' | 'edit'>('edit');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onAnswer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);

  // Sharing is the expected answer to "you mentioned someone who can't see
  // this", so Enter shares — at the role on screen, which the author can see.
  useEffect(() => { shareRef.current?.focus(); }, []);

  const { names, noteTitle } = offer;
  const who = names.length === 1
    ? `@${names[0]}`
    : `${names.slice(0, -1).map(n => `@${n}`).join(', ')} and @${names[names.length - 1]}`;
  const title = noteTitle.trim() || 'Untitled';

  return createPortal(
    <div
      className="share-offer"
      onMouseDown={e => { if (e.target === e.currentTarget) onAnswer(null); }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div
        ref={ref}
        className="share-offer__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-offer-title"
        aria-describedby="share-offer-body"
      >
        <h2 className="share-offer__title" id="share-offer-title">Share with {who}?</h2>
        <p className="share-offer__body" id="share-offer-body">
          You mentioned them in “{title}”, but they can’t open it yet.
          Share the whole note so they can {access === 'edit' ? 'read and edit it with you' : 'read it'}.
        </p>

        <ul className="share-offer__people">
          {names.map(n => (
            <li key={n} className="share-offer__person">
              <Avatar username={n} name={n} size={28} />
              <span>@{n}</span>
            </li>
          ))}
        </ul>

        <div className="share-offer__roles" role="radiogroup" aria-label="Access">
          <button
            type="button"
            role="radio"
            aria-checked={access === 'edit'}
            className="share-offer__role"
            onClick={() => setAccess('edit')}
          >
            <PencilLine size={16} aria-hidden="true" />
            <span className="share-offer__role-name">Can edit</span>
            <span className="share-offer__role-hint">Write in it with you</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={access === 'view'}
            className="share-offer__role"
            onClick={() => setAccess('view')}
          >
            <Eye size={16} aria-hidden="true" />
            <span className="share-offer__role-name">Can view</span>
            <span className="share-offer__role-hint">Read only; they can ask to edit</span>
          </button>
        </div>

        <div className="share-offer__actions">
          <button type="button" className="share-offer__btn" onClick={() => onAnswer(null)}>
            Don’t share
          </button>
          <button
            ref={shareRef}
            type="button"
            className="share-offer__btn share-offer__btn--go"
            onClick={() => onAnswer({ access })}
          >
            Share
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
