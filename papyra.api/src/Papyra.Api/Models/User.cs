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
