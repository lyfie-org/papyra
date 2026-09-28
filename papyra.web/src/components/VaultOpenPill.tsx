import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, LockOpen } from 'lucide-react';
import { useVaultTimeLeft } from '../hooks/useVault';
import { lockVault } from '../lib/vault';
import { useToast } from '../lib/toastContext';
import './VaultOpenPill.css';

// The last stretch before the vault locks itself, when the pill says so.
const ENDING_S = 30;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * "Your vault is open" — in the navbar, on every page, for as long as it is.
 *
 * An open vault used to be invisible anywhere but the Vault page, so there was
 * no telling whether locked notes were readable on this screen right now. The
 * pill shows it, counts down to the automatic lock, and locks on the spot
 * (also ⌘/Ctrl+Shift+L). When the timer closes the vault, a toast says so
 * rather than notes quietly re-locking under the reader.
 */
export default function VaultOpenPill() {
  const left = useVaultTimeLeft();
  const open = left !== null;
  const { toast } = useToast();
  const [locking, setLocking] = useState(false);
  // Set when the person locks it themselves, so only a timeout gets the toast.
  const lockedByHand = useRef(false);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (wasOpen.current && !open) {
      if (!lockedByHand.current) toast('Your vault locked itself. Unlock it again to read locked notes.');
      lockedByHand.current = false;
    }
    wasOpen.current = open;
  }, [open, toast]);

  async function lock() {
    if (locking) return;
    lockedByHand.current = true;
    setLocking(true);
    try {
      await lockVault();
      toast('Vault locked.');
    } finally {
      setLocking(false);
    }
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

  if (!open) return null;
  const ending = left <= ENDING_S;

  return (
    <div className={`vault-pill${ending ? ' is-ending' : ''}`}>
      <Link
        to="/vault"
        className="vault-pill__state"
        title="Your vault is open on this device — locked notes are readable. It locks itself when the timer runs out."
      >
        <LockOpen size={15} aria-hidden="true" />
        <span className="vault-pill__label">Vault open</span>
        <span className="vault-pill__time" aria-label={`locks in ${Math.ceil(left / 60)} minute${left > 60 ? 's' : ''}`}>
          {clock(left)}
        </span>
      </Link>
      <button
        type="button"
        className="vault-pill__lock"
        onClick={() => void lock()}
        disabled={locking}
        title="Lock vault now (⌘/Ctrl+Shift+L)"
        aria-label="Lock vault now"
      >
        <Lock size={14} aria-hidden="true" />
        <span className="vault-pill__lock-label">Lock</span>
      </button>
    </div>
  );
}
