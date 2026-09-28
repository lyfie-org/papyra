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

    // ── Authenticator app (TOTP) ──────────────────────────────────────────────
    // The first way to confirm a sensitive action (an emailed code is the second),
    // and the only one on an instance with no outgoing mail. See Security/TotpService.
    /// <summary>The shared Base32 secret, encrypted with the data-protection keys. Null = not set up.</summary>
    public string? TotpSecret { get; set; }
    /// <summary>The last time step a code was accepted for, so a code can't be replayed.</summary>
    public long? TotpLastStep { get; set; }
    public DateTime? TotpEnabledUtc { get; set; }

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
