import { Lock, LockOpen } from 'lucide-react';
import NoteGrid from '../components/NoteGrid';
import EmptyState from '../components/EmptyState';
import VaultPinForm from '../components/VaultPinForm';
import { useNotes } from '../hooks/useNotes';
import { useVault } from '../hooks/useVault';
import './NotesPage.css';
import './VaultPage.css';

/**
 * The locked vault: every note marked `secure: true`.
 *
 * The server withholds these bodies until the vault is unlocked — with the vault
 * PIN, or a registered device's biometric check — and the editor renders a lock
 * instead of the text. A vault needs a PIN before anything can be locked, so
 * until one exists this page is where it gets set.
 */
export default function VaultPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const { status, open, lock } = useVault();
  const secure = (notes ?? []).filter((n) => n.secure && !n.trashed);
  const pinSet = status.data?.pinSet;

  return (
    <section className="notes-page">
      <header className="notes-page__bar">
        <h1 className="page-title notes-page__title">Vault</h1>
        {pinSet && open && (
          <button type="button" className="vault-page__lock" onClick={() => void lock()}>
            <Lock size={15} /> Lock vault
          </button>
        )}
      </header>

      <p className="notes-page__lede">
        Locked notes. Their contents stay on the server until you unlock your vault with your PIN (or a
        registered device) — nothing is sent to this page before then.
        {pinSet && open && <span className="vault-page__open"><LockOpen size={13} /> Open on this device</span>}
      </p>

      {pinSet === false && (
        <div className="vault-page__setup">
          <h2 className="vault-page__setup-title">Set a vault PIN</h2>
          <p className="notes-page__lede">
            Every vault needs a PIN before notes can be locked. It works on any device; you can add biometrics
            as a shortcut afterwards in Settings → Security.
          </p>
          <VaultPinForm />
        </div>
      )}

      {isLoading && <p className="notes-page__status">Loading…</p>}
      {isError && <p className="notes-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && pinSet !== false && (
        <NoteGrid
          notes={secure}
          variant="active"
          empty={
            <EmptyState
              icon={Lock}
              title="No locked notes"
              body="Locking a note keeps its contents hidden until you unlock your vault. Locked notes stay out of search results and out of anything that reads across your vault, so nothing can quote them back at you."
              hint="To lock a note, open it and choose Lock in its toolbar."
            />
          }
        />
      )}
    </section>
  );
}
