namespace Papyra.Api.Security;

// Minimum bar for a password Papyra will store. Deliberately a length floor and
// nothing else: composition rules (a digit, a symbol, mixed case) push people
// toward `Password1!` and are no longer recommended — length is what buys work
// factor on top of BCrypt.
public static class PasswordPolicy
{
    /// <summary>Shortest password accepted, in characters.</summary>
    public const int MinLength = 8;

    /// <summary>
    /// Longest password accepted. BCrypt hashes only the first 72 *bytes* and
    /// silently ignores the rest, so two passphrases sharing a 72-byte prefix
    /// would verify against each other. Refusing here makes that limit visible
    /// instead of letting someone believe a 200-character passphrase is all
    /// being checked.
    /// </summary>
    public const int MaxBytes = 72;

    /// <summary>
    /// Null when the password is acceptable; otherwise the message to hand back
    /// to the caller. The text never echoes the password itself.
    /// </summary>
    public static string? Validate(string? password)
    {
        if (string.IsNullOrWhiteSpace(password))
            return "Password is required.";
        if (password.Length < MinLength)
            return $"Password must be at least {MinLength} characters.";
        if (System.Text.Encoding.UTF8.GetByteCount(password) > MaxBytes)
            return $"Password must be at most {MaxBytes} bytes ({MaxBytes} ASCII characters).";
        return null;
    }
}
