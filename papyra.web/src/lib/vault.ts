import { fromB64Url, isWebAuthnAvailable, toB64Url } from './webauthn';

/**
 * The vault's client side: the unlock token and the calls that earn one.
 *
 * The token lives in memory only — never localStorage or sessionStorage, where a
 * script injected into the page could find it later, and never past a reload. The
 * server lets it live five minutes; the client forgets it a little sooner so it
 * never sends one the server is about to refuse.
 */

const LIFETIME_MS = 5 * 60_000 - 15_000;

let token: string | null = null;
let expiresAt = 0;
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

/**
 * A server timestamp as a Date. SQLite-backed values can arrive without a zone
 * suffix; they are UTC, and reading them as local time put a lockout (or a
 * "last used") hours off.
 */
export function parseUtc(value: string): Date {
  return new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
}

export function currentUnlockToken(): string | null {
  if (token && Date.now() < expiresAt) return token;
  if (token) { token = null; emit(); }
  return null;
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export function rememberUnlock(next: string): void {
  token = next;
  expiresAt = Date.now() + LIFETIME_MS;
  // Tell subscribers when it lapses, so an open vault visibly closes itself.
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(forgetUnlock, LIFETIME_MS);
  emit();
}

export function forgetUnlock(): void {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  if (token === null) return;
  token = null;
  emit();
}

export function subscribeUnlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** fetch with the live unlock token attached (if there is one). */
export function vaultFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const t = currentUnlockToken();
  if (t) headers.set('X-Unlock-Token', t);
  return fetch(input, { ...init, headers });
}

export interface VaultStatus {
  pinSet: boolean;
  pinDisabled: boolean;
  lockedUntilUtc: string | null;
  attemptsLeft: number;
  pinLength: { min: number; max: number };
  hasPassword: boolean;
  biometric: {
    available: boolean;
    problem: { code: string; message: string } | null;
    rpId: string | null;
    usableHere: number;
    registered: number;
  };
}

/** A refused vault call, with the server's machine-readable reason. */
export class VaultError extends Error {
  readonly code: string | null;
  readonly attemptsLeft: number | null;
  readonly lockedUntil: Date | null;
  readonly status: number;

  constructor(status: number, body: { error?: string; code?: string; attemptsLeft?: number; lockedUntilUtc?: string | null } | null) {
    super(body?.error ?? 'Something went wrong.');
    this.status = status;
    this.code = body?.code ?? null;
    this.attemptsLeft = typeof body?.attemptsLeft === 'number' ? body.attemptsLeft : null;
    this.lockedUntil = body?.lockedUntilUtc ? parseUtc(body.lockedUntilUtc) : null;
  }
}

async function expectToken(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new VaultError(res.status, body);
  const unlockToken = body?.unlockToken as string | undefined;
  if (!unlockToken) throw new VaultError(res.status, { error: 'No unlock was returned.' });
  rememberUnlock(unlockToken);
  return unlockToken;
}

export async function fetchVaultStatus(): Promise<VaultStatus> {
  const res = await fetch('/api/auth/vault');
  if (!res.ok) throw new VaultError(res.status, await res.json().catch(() => null));
  return res.json();
}

/** Set or change the PIN. Pass exactly one proof: the current PIN or the password. */
export function setVaultPin(pin: string, proof: { currentPin?: string; password?: string } = {}): Promise<string> {
  return vaultFetch('/api/auth/vault/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, ...proof }),
  }).then(expectToken);
}

export function unlockWithPin(pin: string): Promise<string> {
  return fetch('/api/auth/vault/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  }).then(expectToken);
}

/** Close the vault on this session, here and on the server. */
export async function lockVault(): Promise<void> {
  forgetUnlock();
  await fetch('/api/auth/vault/lock', { method: 'POST' }).catch(() => undefined);
}

/** Run the platform authenticator (Touch ID / Face ID / Windows Hello) for an unlock. */
export async function unlockWithBiometric(signal?: AbortSignal): Promise<string> {
  if (!isWebAuthnAvailable()) {
    throw new VaultError(0, { error: 'Biometric unlock is not available in this browser here. Use your PIN.' });
  }
  const challengeRes = await fetch('/api/auth/webauthn/challenge', { method: 'POST' });
  if (!challengeRes.ok) throw new VaultError(challengeRes.status, await challengeRes.json().catch(() => null));
  const options = await challengeRes.json();

  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      signal,
      publicKey: {
        ...options,
        challenge: fromB64Url(options.challenge),
        allowCredentials: (options.allowCredentials ?? []).map((c: { id: string; type: string }) => ({
          ...c,
          id: fromB64Url(c.id),
        })),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new VaultError(0, {
      error: e instanceof DOMException && e.name === 'AbortError'
        ? 'Biometric check stopped.'
        : e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Biometric check was cancelled or timed out.'
        : e instanceof Error ? e.message : 'Biometric check failed.',
    });
  }
  if (!assertion) throw new VaultError(0, { error: 'Biometric check was cancelled.' });

  const response = assertion.response as AuthenticatorAssertionResponse;
  return fetch('/api/auth/webauthn/verify', {
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
  }).then(expectToken);
}

/** A PIN the server will accept, checked early so the form can say so. Mirrors Security/VaultPin.cs. */
export function pinProblem(pin: string, min = 6, max = 12): string | null {
  if (!pin) return 'Enter a PIN.';
  if (!/^[0-9]+$/.test(pin)) return 'A PIN is digits only.';
  if (pin.length < min || pin.length > max) return `A PIN is ${min} to ${max} digits.`;
  if ([...pin].every((c) => c === pin[0])) return 'That PIN is too easy to guess — avoid repeated or sequential digits.';
  let up = true, down = true;
  for (let i = 1; i < pin.length; i++) {
    const step = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (step !== 1 && step !== -9) up = false;
    if (step !== -1 && step !== 9) down = false;
  }
  return up || down ? 'That PIN is too easy to guess — avoid repeated or sequential digits.' : null;
}
