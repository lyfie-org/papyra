import { useCallback, useState } from 'react';
import { fromB64Url, toB64Url, isWebAuthnAvailable } from '../lib/webauthn';

type UnlockState = 'locked' | 'authenticating' | 'unlocked' | 'error';

// Drives the biometric unlock for a `secure: true` note: ask the server for an
// assertion challenge, run it through the platform authenticator (Touch ID / Face ID
// / Windows Hello), trade the signed assertion for a short-lived unlock token, then
// fetch the body with it.
//
// The blur is only cosmetic — the body genuinely isn't in the client until this
// succeeds, because the API withholds it server-side.
export function useSecureNote(noteId: string) {
  const [state, setState] = useState<UnlockState>('locked');
  const [error, setError] = useState<string | null>(null);

  // Resolves to the revealed body, or null if the unlock didn't complete.
  const unlock = useCallback(async (): Promise<string | null> => {
    setState('authenticating');
    setError(null);
    try {
      if (!isWebAuthnAvailable()) throw new Error('This browser has no platform authenticator.');

      const challengeRes = await fetch('/api/auth/webauthn/challenge', { method: 'POST' });
      if (!challengeRes.ok) {
        const data = await challengeRes.json().catch(() => null);
        throw new Error(data?.code === 'no_credential'
          ? 'No device registered yet — enrol one in Settings.'
          : 'Could not start authentication.');
      }
      const options = await challengeRes.json();

      const assertion = (await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: fromB64Url(options.challenge),
          allowCredentials: (options.allowCredentials ?? []).map((c: { id: string; type: string }) => ({
            ...c,
            id: fromB64Url(c.id),
          })),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error('Authentication cancelled.');

      const response = assertion.response as AuthenticatorAssertionResponse;
      const verifyRes = await fetch('/api/auth/webauthn/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: {
            id: assertion.id,
            rawId: toB64Url(assertion.rawId),
            type: assertion.type,
            response: {
              authenticatorData: toB64Url(response.authenticatorData),
              clientDataJSON: toB64Url(response.clientDataJSON),
              signature: toB64Url(response.signature),
              userHandle: response.userHandle ? toB64Url(response.userHandle) : null,
            },
          },
        }),
      });
      if (!verifyRes.ok) throw new Error('Authentication failed.');
      const { unlockToken } = await verifyRes.json();

      const bodyRes = await fetch(`/api/notes/${encodeURIComponent(noteId)}/secure`, {
        headers: { 'X-Unlock-Token': unlockToken },
      });
      if (!bodyRes.ok) throw new Error('Could not unlock this note.');
      const note = await bodyRes.json();

      setState('unlocked');
      return note.body ?? '';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed.');
      setState('error');
      return null;
    }
  }, [noteId]);

  return { state, error, unlock };
}
