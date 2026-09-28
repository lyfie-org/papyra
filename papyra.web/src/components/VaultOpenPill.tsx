import { useEffect, useRef, useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen } from 'lucide-react';
import type { Note } from '../types/note';
import { useVaultTimeLeft } from '../hooks/useVault';
import { lockVault, touchVault } from '../lib/vault';
import { useRealLocation } from '../lib/realLocation';
import { useToast } from '../lib/toastContext';
import './VaultOpenPill.css';

// The last stretch before the vault locks itself, when the pill says so.
const ENDING_S = 30;
// How long the "locked" state shows before the pill fades away.
const LOCKED_BEAT_MS = 450;
const FADE_MS = 280;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Keep the vault open while someone is using it. "Using" means input — a click,
 * a key, a wheel scroll, a touch — while looking at the Vault page or a locked note.
 * Idle anywhere, including on the Vault page, and the countdown runs.
 */
function useVaultKeepAlive(open: boolean) {
  const background = useLocation();
  const real = useRealLocation();
  const queryClient = useQueryClient();
  // Read through a ref so the listeners below are attached once per open vault.
  const inVault = useRef(false);

  const openNoteId = real ? matchPath('/note/:id', real.pathname)?.params.id : undefined;
  const openNote = openNoteId
    ? queryClient.getQueryData<Note[]>(['notes'])?.find((n) => n.id === openNoteId)
    : undefined;
  const here = background.pathname.startsWith('/vault') || !!openNote?.secure;
  useEffect(() => { inVault.current = here; }, [here]);

  useEffect(() => {
    if (!open) return;
    const onActivity = () => { if (inVault.current) touchVault(); };
    const opts = { capture: true, passive: true } as const;
    // Input only: a `scroll` event also fires for programmatic scrolls (a page
    // resetting to its top), which is not someone reading.
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) document.addEventListener(e, onActivity, opts);
    return () => { for (const e of events) document.removeEventListener(e, onActivity, opts); };
  }, [open]);
}

/**
 * "Your vault is open" — in the navbar, on every page, for as long as it is.
 *
 * Shows the countdown to the automatic lock (held while the vault is being
 * used — see useVaultKeepAlive), and locks on the spot, also with
 * ⌘/Ctrl+Shift+L. Locking plays out: the open padlock snaps shut, then the pill
 * fades. When the timer closes the vault, a toast says so rather than notes
 * quietly re-locking under the reader.
 */
export default function VaultOpenPill() {
  const left = useVaultTimeLeft();
  const open = left !== null;
  const { toast } = useToast();
  // 'locked' = the padlock has shut, 'fading' = on its way out.
  const [closing, setClosing] = useState<null | 'locked' | 'fading'>(null);
  const lockedByHand = useRef(false);
  const wasOpen = useRef(open);

  useVaultKeepAlive(open);

  useEffect(() => {
    if (wasOpen.current && !open && !lockedByHand.current) {
      toast('Your vault locked itself after 5 idle minutes. Unlock it again to read locked notes.');
    }
    if (!open) lockedByHand.current = false;
    wasOpen.current = open;
  }, [open, toast]);

  useEffect(() => {
    if (closing !== 'locked') return;
    const t = setTimeout(() => setClosing('fading'), LOCKED_BEAT_MS);
    return () => clearTimeout(t);
  }, [closing]);
  useEffect(() => {
    if (closing !== 'fading') return;
    const t = setTimeout(() => setClosing(null), FADE_MS);
    return () => clearTimeout(t);
  }, [closing]);

  async function lock() {
    if (closing) return;
    lockedByHand.current = true;
    setClosing('locked');
    // The vault closes now; the animation is only the telling of it.
    await lockVault();
  }

  // ⌘/Ctrl+Shift+L: lock from anywhere, mid-sentence included.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void lock();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!open && !closing) return null;
  const shown = left ?? 0;
  const ending = !closing && shown <= ENDING_S;
  const cls = ['vault-pill', ending && 'is-ending', closing && 'is-locked', closing === 'fading' && 'is-fading']
    .filter(Boolean).join(' ');

  return (
    <div className={cls} role={closing ? 'status' : undefined}>
      <Link
        to="/vault"
        className="vault-pill__state"
        tabIndex={closing ? -1 : undefined}
        title="Your vault is open on this device — locked notes are readable. It locks itself after 5 idle minutes."
      >
        <span className="vault-pill__label">{closing ? 'Vault locked' : 'Vault open'}</span>
        {!closing && (
          <span className="vault-pill__time" aria-label={`locks in ${Math.ceil(shown / 60)} minute${shown > 60 ? 's' : ''} if idle`}>
            {clock(shown)}
          </span>
        )}
      </Link>
      <button
        type="button"
        className="vault-pill__lock"
        onClick={() => void lock()}
        disabled={!!closing}
        title="Lock vault now (⌘/Ctrl+Shift+L)"
        aria-label="Lock vault now"
      >
        <span className="vault-pill__padlock" aria-hidden="true">
          <LockOpen size={14} className="vault-pill__padlock-open" />
          <Lock size={14} className="vault-pill__padlock-shut" />
        </span>
        <span className="vault-pill__lock-label">Lock</span>
      </button>
    </div>
  );
}
