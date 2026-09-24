import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attestationToJson, isWebAuthnAvailable, toCreationOptions } from '../lib/webauthn';
import { vaultFetch } from '../lib/vault';
import { VAULT_KEY } from './useVault';

export interface WebAuthnDevice {
  id: number;
  name: string;
  createdUtc: string;
  lastUsedUtc: string | null;
  /** The host this passkey belongs to (empty for ones registered before this was recorded). */
  rpId: string;
}

const DEVICES_KEY = ['webauthnDevices'];

// Manages the biometric devices enrolled against this account: list, enrol a new
// one (Touch ID / Face ID / Windows Hello), and revoke. Enrolling is a two-step
// ceremony — the server issues a single-use challenge, the authenticator signs it,
// and the server verifies before storing the public key. Enrolling and removing
// both need the vault open (the unlock token rides along via vaultFetch): a
// session alone must not be able to add a way into the vault.
export function useWebAuthnDevices() {
  const queryClient = useQueryClient();
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devices = useQuery<WebAuthnDevice[]>({
    queryKey: DEVICES_KEY,
    queryFn: async () => {
      const res = await fetch('/api/auth/webauthn/credentials');
      if (!res.ok) throw new Error(`GET credentials failed: ${res.status}`);
      return res.json();
    },
  });

  const enroll = useCallback(async (name: string) => {
    setError(null);
    if (!isWebAuthnAvailable()) {
      setError('This browser can’t use biometric keys here. A secure context (HTTPS or localhost) is required.');
      return false;
    }

    setEnrolling(true);
    try {
      const challengeRes = await vaultFetch('/api/auth/webauthn/register/challenge', { method: 'POST' });
      if (!challengeRes.ok) {
        const data = await challengeRes.json().catch(() => null);
        throw new Error(data?.error ?? 'Could not start enrolment.');
      }
      const options = await challengeRes.json();

      const credential = (await navigator.credentials.create({
        publicKey: toCreationOptions(options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error('Enrolment was cancelled.');

      const verifyRes = await vaultFetch('/api/auth/webauthn/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestationToJson(credential), name: name.trim() || 'This device' }),
      });
      if (!verifyRes.ok) {
        const data = await verifyRes.json().catch(() => null);
        throw new Error(data?.error ?? 'Could not verify this device.');
      }

      await queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      await queryClient.invalidateQueries({ queryKey: VAULT_KEY });
      return true;
    } catch (e) {
      // A user who dismisses the OS prompt lands here as NotAllowedError — that's a
      // cancellation, not a failure worth alarming them about.
      const message = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Enrolment was cancelled or timed out.'
        : e instanceof Error ? e.message : 'Could not enrol this device.';
      setError(message);
      return false;
    } finally {
      setEnrolling(false);
    }
  }, [queryClient]);

  const revoke = useCallback(async (id: number) => {
    const res = await vaultFetch(`/api/auth/webauthn/credentials/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      await queryClient.invalidateQueries({ queryKey: VAULT_KEY });
      return true;
    }
    const data = await res.json().catch(() => null);
    setError(data?.error ?? 'Could not remove that device.');
    return false;
  }, [queryClient]);

  return { devices, enroll, revoke, enrolling, error, setError };
}
