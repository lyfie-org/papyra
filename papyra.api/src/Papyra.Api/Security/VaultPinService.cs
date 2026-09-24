using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>Outcome of checking a vault PIN.</summary>
public enum PinCheck
{
    Ok,
    /// <summary>Wrong PIN; see <see cref="PinVerdict.AttemptsLeft"/> and any new lockout.</summary>
    Wrong,
    /// <summary>Refused without checking — a timed lockout is running.</summary>
    Locked,
    /// <summary>Refused without checking — too many misses; reset with the password or a biometric unlock.</summary>
    Disabled,
    /// <summary>No PIN has been set.</summary>
    NotSet,
}

public sealed record PinVerdict(PinCheck Result, int AttemptsLeft, DateTime? LockedUntilUtc);

/// <summary>
/// Sets and checks the vault PIN (policy in <see cref="VaultPin"/>).
///
/// Checks for one user are serialised: without that, a burst of parallel guesses
/// would all read the same failure count and each get a free try, which turns
/// "ten misses and it locks" into "as many as you can send at once".
/// </summary>
public sealed class VaultPinService
{
    // BCrypt cost for the PIN hash. A PIN has little entropy, so the lockout is
    // the real defence; the cost still makes an offline attack on a leaked
    // database slower per guess.
    private const int WorkFactor = 12;

    private static readonly ConcurrentDictionary<int, SemaphoreSlim> Gates = new();

    private readonly AppDbContext _db;
    private readonly UnlockTokenStore _unlockTokens;
    private readonly ILogger<VaultPinService> _logger;

    public VaultPinService(AppDbContext db, UnlockTokenStore unlockTokens, ILogger<VaultPinService> logger)
    {
        _db = db;
        _unlockTokens = unlockTokens;
        _logger = logger;
    }

    public async Task<PinVerdict> CheckAsync(int userId, string? pin, CancellationToken ct)
    {
        var gate = Gates.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            // Re-read inside the gate so the count is the one the previous guess wrote.
            var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null || string.IsNullOrEmpty(user.VaultPinHash))
                return new PinVerdict(PinCheck.NotSet, 0, null);
            await _db.Entry(user).ReloadAsync(ct);

            if (VaultPin.IsHardLocked(user.VaultPinFailures))
                return new PinVerdict(PinCheck.Disabled, 0, null);
            var now = DateTime.UtcNow;
            // SQLite returns the stored value unmarked; it was written as UTC.
            if (user.VaultPinLockedUntilUtc is { } until && until > now)
                return new PinVerdict(PinCheck.Locked, VaultPin.AttemptsLeft(user.VaultPinFailures),
                    DateTime.SpecifyKind(until, DateTimeKind.Utc));

            // A malformed guess is still a guess: counting it stops "not digits"
            // from being a free probe.
            var ok = !string.IsNullOrEmpty(pin) && pin.Length <= VaultPin.MaxLength
                && BCrypt.Net.BCrypt.Verify(pin, user.VaultPinHash);

            if (ok)
            {
                user.VaultPinFailures = 0;
                user.VaultPinLockedUntilUtc = null;
                await _db.SaveChangesAsync(ct);
                return new PinVerdict(PinCheck.Ok, VaultPin.HardLimit, null);
            }

            user.VaultPinFailures++;
            var wait = VaultPin.LockoutAfter(user.VaultPinFailures);
            user.VaultPinLockedUntilUtc = wait is null ? null : now.Add(wait.Value);
            await _db.SaveChangesAsync(ct);

            _logger.LogWarning("Wrong vault PIN for user {UserId} ({Failures} in a row)", userId, user.VaultPinFailures);
            if (VaultPin.IsHardLocked(user.VaultPinFailures))
            {
                // Nothing unlocked under this PIN should outlive it being disabled.
                _unlockTokens.RevokeUser(userId.ToString());
                return new PinVerdict(PinCheck.Disabled, 0, null);
            }
            return new PinVerdict(PinCheck.Wrong, VaultPin.AttemptsLeft(user.VaultPinFailures), user.VaultPinLockedUntilUtc);
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>
    /// Store a new PIN (already validated and authorised by the caller). Clears the
    /// failure history and revokes every unlock issued under the old one.
    /// </summary>
    public async Task SetAsync(User user, string pin, CancellationToken ct)
    {
        user.VaultPinHash = BCrypt.Net.BCrypt.HashPassword(pin, WorkFactor);
        user.VaultPinFailures = 0;
        user.VaultPinLockedUntilUtc = null;
        await _db.SaveChangesAsync(ct);
        _unlockTokens.RevokeUser(user.Id.ToString());
        _logger.LogInformation("Vault PIN set for user {UserId}", user.Id);
    }
}
