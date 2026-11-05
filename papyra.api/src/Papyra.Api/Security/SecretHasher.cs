namespace Papyra.Api.Security;

/// <summary>
/// Hashes account passwords and vault PINs with BCrypt. The cost is BCrypt's own default
/// (passwords) or <see cref="VaultPinService"/>'s chosen one (PINs), unless the process was
/// started with <c>PAPYRA_TEST_BCRYPT_COST</c>.
///
/// That variable exists for the test suite: every test boots an app and signs in, so at the
/// real cost the hashing alone dominates a run. Verifying is unaffected — the cost lives
/// inside each stored hash, so hashes made at any cost still check out. It is not a setting
/// to use on a real install; a low cost makes a leaked database cheaper to attack.
/// </summary>
public static class SecretHasher
{
    private const string CostVariable = "PAPYRA_TEST_BCRYPT_COST";

    // BCrypt's own bounds; anything outside is ignored rather than clamped, so a typo
    // can't quietly weaken real hashes.
    private const int MinCost = 4;
    private const int MaxCost = 31;

    /// <summary>The cost forced by <c>PAPYRA_TEST_BCRYPT_COST</c>, or null for the normal ones.</summary>
    public static int? CostOverride { get; } = ReadOverride();

    /// <summary>Hash an account password at BCrypt's default cost.</summary>
    public static string HashPassword(string password) =>
        CostOverride is int cost
            ? BCrypt.Net.BCrypt.HashPassword(password, cost)
            : BCrypt.Net.BCrypt.HashPassword(password);

    /// <summary>Hash a secret at the given cost (the vault PIN's).</summary>
    public static string Hash(string secret, int workFactor) =>
        BCrypt.Net.BCrypt.HashPassword(secret, CostOverride ?? workFactor);

    private static int? ReadOverride()
    {
        var raw = Environment.GetEnvironmentVariable(CostVariable);
        return int.TryParse(raw, out var cost) && cost is >= MinCost and <= MaxCost ? cost : null;
    }
}
