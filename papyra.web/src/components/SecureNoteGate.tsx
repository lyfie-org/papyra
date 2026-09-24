import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { useVault } from '../hooks/useVault';
import { forgetUnlock, vaultFetch } from '../lib/vault';
import VaultUnlock from './VaultUnlock';
import VaultPinForm from './VaultPinForm';
import './SecureNoteGate.css';

// The reveal gate for a `secure: true` note. Until the vault is open the body is
// genuinely absent from the client (the API withholds it), so the blur here is
// presentation, not protection.
//
// Opens with the vault PIN, or the device's biometric check where one is set up
// for this address. If the vault is already open on this session (another note
// was unlocked a moment ago) the note opens straight away.
export default function SecureNoteGate({
  noteId,
  onUnlocked,
}: {
  noteId: string;
  onUnlocked: (body: string) => void;
}) {
  const { status, open } = useVault();
  const [error, setError] = useState<string | null>(null);
  const revealing = useRef(false);

  const reveal = useCallback(async () => {
    if (revealing.current) return;
    revealing.current = true;
    try {
      const res = await vaultFetch(`/api/notes/${encodeURIComponent(noteId)}/secure`);
      if (res.status === 401) { forgetUnlock(); return; } // the unlock lapsed — ask again
      if (!res.ok) { setError('Could not open this note.'); return; }
      const note = await res.json();
      onUnlocked(note.body ?? '');
    } catch {
      setError('Could not reach the server.');
    } finally {
      revealing.current = false;
    }
  }, [noteId, onUnlocked]);

  // Already open on this session: no prompt.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void reveal(), 0);
    return () => clearTimeout(t);
  }, [open, reveal]);

  const pinSet = status.data?.pinSet;

  return (
    <div className="secure-gate">
      <div className="secure-gate__placeholder" aria-hidden="true">
        <p>████ ███████ ██ ████████ █████</p>
        <p>███████ ████ ██████ ███ █████████ ██</p>
        <p>█████ ███████ ████ ██</p>
      </div>

      <div className="secure-gate__panel" role="group" aria-label="Locked note">
        <Lock size={22} className="secure-gate__icon" />
        <h2 className="secure-gate__title">This note is locked</h2>
        {pinSet === false ? (
          <>
            <p className="secure-gate__hint">
              Set a vault PIN to open locked notes. It works on every device, with biometrics as an optional
              shortcut you can add later in Settings.
            </p>
            <VaultPinForm />
          </>
        ) : (
          <>
            <p className="secure-gate__hint">
              Its contents stay on the server until you unlock your vault.
            </p>
            {!open && <VaultUnlock autoBiometric onUnlocked={() => void reveal()} />}
            {open && <p className="secure-gate__hint">Opening…</p>}
          </>
        )}
        {error && <p className="secure-gate__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
