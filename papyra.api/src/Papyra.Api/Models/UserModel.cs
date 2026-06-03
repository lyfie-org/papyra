namespace Papyra.Api.Models;

public sealed class UserModel
{
    public required string Username      { get; set; }
    public required string Name          { get; set; }
    public required string Email         { get; set; }
    public required string PasswordHash  { get; set; }
    public string Role                   { get; set; } = "member";
    public DateTime CreatedAt            { get; set; } = DateTime.UtcNow;

    // TOTP 2FA
    // TwoFactorSecretEnc: AES-GCM encrypted via EncryptionService ("enc:<nonce>:<ct>:<tag>")
    public string? TwoFactorSecretEnc    { get; set; }
    public string? TwoFactorSecret       { get; set; } // migration source only; cleared after encryption
    public bool    TwoFactorEnabled      { get; set; } = false;

    // 8 single-use recovery codes (bcrypt-hashed); generated when 2FA is confirmed.
    public List<RecoveryCodeEntry>? RecoveryCodes { get; set; }

    // Set to true when an admin creates the account — forces reset before first use
    public bool    MustResetPassword     { get; set; } = false;

    // Email verification (Phase 3)
    public bool    EmailVerified         { get; set; } = false;

    // Pending tokens — stored hashed (SHA-256 hex). Expires recorded as UTC ticks.
    public string? EmailVerificationTokenHash { get; set; }
    public long    EmailVerificationTokenExpiry { get; set; } // UTC ticks; 0 = none

    public string? PasswordResetTokenHash    { get; set; }
    public long    PasswordResetTokenExpiry  { get; set; } // UTC ticks; 0 = none
}

public sealed class RecoveryCodeEntry
{
    public required string CodeHash { get; set; } // bcrypt hash of the plaintext code
    public DateTime? UsedAt         { get; set; } // null = unused; non-null = consumed
}
