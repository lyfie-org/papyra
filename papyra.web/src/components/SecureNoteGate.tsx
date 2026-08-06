import { Fingerprint, Lock } from 'lucide-react';
import { useSecureNote } from '../hooks/useSecureNote';
import './SecureNoteGate.css';

// The reveal gate for a `secure: true` note. Until the biometric handshake
// succeeds the body is genuinely absent from the client (the API withholds it), so
// the blur here is presentation, not protection.
export default function SecureNoteGate({
  noteId,
  onUnlocked,
}: {
  noteId: string;
  onUnlocked: (body: string) => void;
}) {
  const { state, error, unlock } = useSecureNote(noteId);

  async function handle() {
    const body = await unlock();
    if (body !== null) onUnlocked(body);
  }

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
        <p className="secure-gate__hint">
          Its contents stay on the server until you authenticate on this device.
        </p>
        <button
          type="button"
          className="secure-gate__btn"
          disabled={state === 'authenticating'}
          onClick={() => void handle()}
        >
          <Fingerprint size={16} />
          {state === 'authenticating' ? 'Waiting for authenticator…' : 'Authenticate to view'}
        </button>
        {error && <p className="secure-gate__error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
