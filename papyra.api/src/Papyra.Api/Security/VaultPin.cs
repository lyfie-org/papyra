namespace Papyra.Api.Security;

/// <summary>
/// The rules for the vault PIN: what counts as an acceptable PIN, and how hard a
/// wrong guess is punished. Pure so it can be tested without a database.
///
/// A PIN is short by design, so the lockout is what makes it safe. Four free
/// misses (typos happen), then an escalating wait, and after
/// <see cref="HardLimit"/> consecutive misses the PIN stops working until it is
/// reset with the account password or a biometric unlock. With a 6-digit PIN an
/// attacker holding a stolen session gets ten guesses in a million.
/// </summary>
public static class VaultPin
{
    public const int MinLength = 6;
    public const int MaxLength = 12;

    /// <summary>Consecutive failures after which the PIN is disabled until reset.</summary>
    public const int HardLimit = 10;

    /// <summary>Failures tolerated before the first timed lockout.</summary>
    public const int FreeAttempts = 4;

    /// <summary>Why a proposed PIN is unacceptable, or null when it is fine.</summary>
    public static string? Validate(string? pin)
    {
        if (string.IsNullOrEmpty(pin)) return "Enter a PIN.";
        if (!pin.All(char.IsAsciiDigit)) return "A PIN is digits only.";
        if (pin.Length < MinLength || pin.Length > MaxLength)
            return $"A PIN is {MinLength} to {MaxLength} digits.";
        if (IsTrivial(pin)) return "That PIN is too easy to guess — avoid repeated or sequential digits.";
        return null;
    }

    // Repeated digits (000000) and straight runs either way (123456, 987654) are
    // the first things anyone tries.
    private static bool IsTrivial(string pin)
    {
        if (pin.All(c => c == pin[0])) return true;
        bool up = true, down = true;
        for (var i = 1; i < pin.Length; i++)
        {
            var step = pin[i] - pin[i - 1];
            if (step != 1 && step != -9) up = false;   // 7890 wraps
            if (step != -1 && step != 9) down = false; // 1098 wraps
        }
        return up || down;
    }

    /// <summary>True once the PIN has been disabled by too many misses.</summary>
    public static bool IsHardLocked(int failures) => failures >= HardLimit;

    /// <summary>
    /// How long to refuse attempts after the <paramref name="failures"/>-th
    /// consecutive miss. Null means no wait (still inside the free attempts, or
    /// hard-locked — which <see cref="IsHardLocked"/> reports separately).
    /// </summary>
    public static TimeSpan? LockoutAfter(int failures) => failures switch
    {
        <= FreeAttempts => null,
        5 => TimeSpan.FromSeconds(30),
        6 => TimeSpan.FromMinutes(1),
        7 => TimeSpan.FromMinutes(5),
        8 => TimeSpan.FromMinutes(15),
        9 => TimeSpan.FromHours(1),
        _ => null,
    };

    /// <summary>Misses left before the PIN is disabled.</summary>
    public static int AttemptsLeft(int failures) => Math.Max(0, HardLimit - failures);
}
