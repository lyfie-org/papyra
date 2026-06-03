namespace Papyra.Api.Models;

// ── GlobalSettingsModel ──────────────────────────────────────────────────────
// Persisted to {storageRoot}/.system/settings.json.
// These are instance-wide settings controlled by an admin.

public sealed class GlobalSettingsModel
{
    /// <summary>When true, any visitor may create a member account via POST /api/auth/register.</summary>
    public bool AllowSelfRegistration { get; set; } = false;

    /// <summary>When true, newly registered users must verify their email address before logging in.</summary>
    public bool RequireEmailVerification { get; set; } = false;

    /// <summary>SMTP configuration. Password is stored AES-GCM-encrypted via EncryptionService.</summary>
    public SmtpSettings? Smtp { get; set; }
}

// ── SmtpSettings ─────────────────────────────────────────────────────────────
// Stored inside GlobalSettingsModel. PasswordEnc uses the "enc:…" envelope.
// GET /api/admin/settings redacts PasswordEnc → hasPassword:bool.

public sealed class SmtpSettings
{
    public string  Host        { get; set; } = string.Empty;
    public int     Port        { get; set; } = 587;
    public string  Security    { get; set; } = "starttls"; // "none" | "starttls" | "ssl"
    public string  Username    { get; set; } = string.Empty;
    /// <summary>AES-GCM encrypted via EncryptionService. Never returned to clients.</summary>
    public string? PasswordEnc { get; set; }
    public string  FromAddress { get; set; } = string.Empty;
    public string  FromName    { get; set; } = "Papyra";
}
