namespace Papyra.Api.Models;

// Tenant identity. Auth (BCrypt hash, cookie sessions) wired in Phase 6.
public class User
{
    public int Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Role { get; set; } = "User";
    /// <summary>
    /// Set when an admin created or reset this account with a password they
    /// chose, so the owner has never picked their own. While it is true the API
    /// refuses everything except signing out and setting a new password, which
    /// is the only way to clear it — an admin who knows a password must not be
    /// able to keep reading that account's notes with it.
    /// </summary>
    public bool MustChangePassword { get; set; }

    // The external IdP subject for SSO-provisioned users (OIDC `sub`). Null for
    // local password accounts; unique when set so one IdP identity maps to one user.
    public string? ExternalId { get; set; }

    // ── Email notification preferences ────────────────────────────────────────
    // Opt-OUT (default true): someone who has given Papyra their address and had
    // a teammate @mention them expects to hear about it. Each is honoured at the
    // send site, so switching one off stops that mail without affecting the
    // in-app inbox, which is never suppressed — the notification is a courtesy
    // copy, not the delivery mechanism.
    public bool NotifyOnMention { get; set; } = true;
    public bool NotifyOnShare { get; set; } = true;
    /// <summary>Security mail (password changed, reset requested). Cannot be disabled.</summary>
    public bool NotifyOnSecurity { get; set; } = true;
    /// <summary>
    /// Per-channel switches for everything in NotificationCatalog, as JSON —
    /// only the ones that differ from their default. See NotificationPrefs.
    /// </summary>
    public string? NotificationPrefs { get; set; }

    // ── Admin controls ────────────────────────────────────────────────────────
    /// <summary>
    /// Set when an administrator disabled the account (a leaked password, someone
    /// who left). While set nothing signs in — password, passkey, SSO or API key —
    /// and any session already open is refused on its next request.
    /// </summary>
    public DateTime? DisabledUtc { get; set; }
    /// <summary>Why, as the admin wrote it. Shown to other admins, never to the account.</summary>
    public string? DisabledReason { get; set; }
    /// <summary>The last successful sign-in, for the roster.</summary>
    public DateTime? LastSignInUtc { get; set; }

    // ── Vault (secure notes) ──────────────────────────────────────────────────
    // A PIN is required before any note can be locked; biometrics are an optional
    // second way in. Only a BCrypt hash is stored. The failure counter and lockout
    // live on the row (not in memory) so a restart does not hand an attacker a
    // fresh set of guesses. See Security/VaultPin.cs for the policy.
    public string? VaultPinHash { get; set; }
    public int VaultPinFailures { get; set; }
    public DateTime? VaultPinLockedUntilUtc { get; set; }

    // ── Authenticator apps (TOTP) ─────────────────────────────────────────────
    // Held in UserAuthenticator rows (one or more per account); see Security/TotpService.
    /// <summary>
    /// Ask for the authenticator code at sign-in (two-step sign-in). Always on for
    /// administrators whatever this says; people can switch it off for themselves.
    /// Sensitive actions ask for a code either way.
    /// </summary>
    public bool TwoFactorLogin { get; set; } = true;

    /// <summary>
    /// IANA time zone the person reads times in ("Europe/Berlin"). Null = the
    /// server's own zone (the container's TZ), which /api/auth/me reports.
    /// </summary>
    public string? TimeZone { get; set; }

    /// <summary>
    /// "light", "dark" or "system" — chosen at setup, changed from the app's theme
    /// toggle. Stored on the account so every browser this person signs in to
    /// opens in it. Null = never chosen (the browser decides).
    /// </summary>
    public string? Theme { get; set; }

    // ── Password age + account deletion ───────────────────────────────────────
    /// <summary>When the password was last set. Deleting the account needs it to be over a day old.</summary>
    public DateTime? PasswordChangedUtc { get; set; }
    /// <summary>
    /// Set when the owner asked for the account to be deleted: everything is
    /// purged at this moment unless they cancel first. Until then the account can
    /// only sign in to cancel.
    /// </summary>
    public DateTime? DeletionScheduledUtc { get; set; }
    /// <summary>The last daily "your account will be deleted" email.</summary>
    public DateTime? DeletionReminderUtc { get; set; }
}

// A browser or device that has signed in to an account before. A sign-in from one
// that isn't on the list is "new", and the owner is told. The id lives in a
// long-lived cookie on that browser; only its SHA-256 is stored here.
public class KnownDevice
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public string DeviceHash { get; set; } = string.Empty;
    /// <summary>A short description of the browser ("Chrome on Windows").</summary>
    public string Label { get; set; } = string.Empty;
    public string? LastIp { get; set; }
    public DateTime FirstSeenUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
    /// <summary>
    /// "Remember this device": until then, signing in here skips the
    /// authenticator code. Null = ask every time.
    /// </summary>
    public DateTime? TrustedUntilUtc { get; set; }
}

// One signed-in browser. The session cookie carries its id (the `sid` claim) and
// every request checks the row, so a session revoked from Settings → Security →
// Signed-in devices ends on its very next request, not when its cookie expires.
public class UserSession
{
    public int Id { get; set; }
    public int UserId { get; set; }
    /// <summary>SHA-256 of the random session id in the cookie.</summary>
    public string SessionHash { get; set; } = string.Empty;
    /// <summary>"Chrome on Windows".</summary>
    public string Label { get; set; } = string.Empty;
    public string? LastIp { get; set; }
    /// <summary>
    /// The browser it belongs to (hash of the long-lived device cookie). A new
    /// sign-in from the same browser replaces the old session, so the list shows
    /// each browser once however often it signs in.
    /// </summary>
    public string? DeviceHash { get; set; }
    /// <summary>How it signed in: Password, Passkey, Single sign-on…</summary>
    public string Method { get; set; } = string.Empty;
    /// <summary>Signed in with "Remember this device": a long-lived cookie.</summary>
    public bool Remember { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
}

// A one-time token for a password reset or an invitation. Rows are short-lived
// and single-use: consumed on redemption, swept once expired.
public class AuthToken
{
    public int Id { get; set; }
    /// <summary>SHA-256 of the token handed out, never the token itself.</summary>
    public string TokenHash { get; set; } = string.Empty;
    /// <summary>"reset" or "invite".</summary>
    public string Kind { get; set; } = "reset";
    /// <summary>The account being reset. Null for an invite, which has no account yet.</summary>
    public int? UserId { get; set; }
    /// <summary>Invite only: the address invited, and the username to create.</summary>
    public string Email { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string Role { get; set; } = "User";
    public DateTime ExpiresUtc { get; set; }
    public DateTime? UsedUtc { get; set; }
}

// One authenticator app on an account. Its code confirms sensitive steps (and,
// with two-step sign-in, signing in); any of the account's apps will do.
public class UserAuthenticator
{
    public int Id { get; set; }
    public int UserId { get; set; }
    /// <summary>What the person called it: "Phone", "1Password".</summary>
    public string Name { get; set; } = string.Empty;
    /// <summary>The shared Base32 secret, encrypted with the data-protection keys.</summary>
    public string Secret { get; set; } = string.Empty;
    /// <summary>The last time step a code was accepted for, so a code can't be replayed.</summary>
    public long? LastStep { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
}

// A sign-in identity from an SSO provider, tied to a Papyra account. One account
// can carry several (Authentik and Google, say); within a provider the subject
// (`sub`) is the durable key — emails change, `sub` doesn't.
public class ExternalLogin
{
    public int Id { get; set; }
    public int UserId { get; set; }
    /// <summary>The provider's id in Settings → SSO ("oidc" for the original single provider).</summary>
    public string Provider { get; set; } = string.Empty;
    /// <summary>The IdP's `sub` claim.</summary>
    public string Subject { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
}
