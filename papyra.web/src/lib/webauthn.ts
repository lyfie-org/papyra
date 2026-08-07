// WebAuthn wire helpers. The browser API speaks ArrayBuffers while the server
// speaks base64url JSON, so every credential id, challenge and signature crosses
// this boundary. Shared by enrolment (Settings) and unlock (secure notes).

export function fromB64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function toB64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A platform authenticator (Touch ID / Face ID / Windows Hello) needs both the
// WebAuthn API and a secure context — browsers expose it only over HTTPS or on
// localhost, so a LAN-IP deployment will legitimately report false here.
export function isWebAuthnAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext;
}

// Whether this device actually has a built-in biometric authenticator, as opposed
// to only supporting roaming keys. Used to explain *why* enrolment is unavailable.
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// The server hands back Fido2's CredentialCreateOptions as JSON; the browser wants
// the binary fields as buffers. Translate, leaving everything else untouched.
export function toCreationOptions(options: {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: string; transports?: string[] }[];
  [key: string]: unknown;
}): PublicKeyCredentialCreationOptions {
  // The server's JSON carries fields TypeScript can't see through the index
  // signature (rp, pubKeyCredParams, …); they pass through the spread untouched,
  // so the cast goes via `unknown`.
  return {
    ...options,
    challenge: fromB64Url(options.challenge),
    user: { ...options.user, id: fromB64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: fromB64Url(c.id),
      type: 'public-key' as const,
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
}

// Serialize a freshly created credential into the shape Fido2NetLib expects
// (the standard WebAuthn JSON encoding, base64url throughout).
export function attestationToJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toB64Url(credential.rawId),
    type: credential.type,
    extensions: credential.getClientExtensionResults(),
    response: {
      attestationObject: toB64Url(response.attestationObject),
      clientDataJSON: toB64Url(response.clientDataJSON),
    },
  };
}
