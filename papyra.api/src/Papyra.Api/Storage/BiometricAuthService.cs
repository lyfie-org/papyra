using System.Buffers.Text;
using System.Text;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Security;

namespace Papyra.Api.Storage;

// WebAuthn gatekeeper. Wraps Fido2NetLib to register platform authenticators
// (Touch ID / Face ID / Windows Hello) and verify assertions. All signature,
// challenge, origin and replay-counter checking is delegated to the library —
// never hand-rolled.
//
// The relying party is per request (see WebAuthnRelyingParty): Papyra answers on
// whatever address its owner uses, and a passkey belongs to the host it was made
// on. Pending challenges live in the singleton WebAuthnChallengeStore; they are
// single-use, expire, and are verified against the same relying party they were
// issued for.
public sealed class BiometricAuthService
{
    private readonly AppDbContext _db;
    private readonly WebAuthnChallengeStore _challenges;
    private readonly UnlockTokenStore _unlockTokens;
    private readonly ILogger<BiometricAuthService> _logger;

    public BiometricAuthService(
        AppDbContext db,
        WebAuthnChallengeStore challenges,
        UnlockTokenStore unlockTokens,
        ILogger<BiometricAuthService> logger)
    {
        _db = db;
        _challenges = challenges;
        _unlockTokens = unlockTokens;
        _logger = logger;
    }

    private static Fido2 For(RelyingParty party) => new(new Fido2Configuration
    {
        ServerDomain = party.RpId,
        ServerName = "Papyra",
        Origins = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { party.Origin },
        Timeout = (uint)WebAuthnChallengeStore.Lifetime.TotalMilliseconds,
    });

    // A credential made before rp ids were recorded has an empty RpId; offer it
    // everywhere and let the authenticator decide, as before.
    private static bool UsableAt(WebAuthnCredential c, RelyingParty party) =>
        c.RpId.Length == 0 || string.Equals(c.RpId, party.RpId, StringComparison.OrdinalIgnoreCase);

    // ── Registration ────────────────────────────────────────────────────────────

    public async Task<CredentialCreateOptions> RegisterChallengeAsync(User user, RelyingParty party, CancellationToken ct)
    {
        var existing = await _db.WebAuthnCredentials.Where(c => c.UserId == user.Id).ToListAsync(ct);
        var options = For(party).RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User
            {
                Id = Encoding.UTF8.GetBytes(user.Id.ToString()),
                Name = user.Username,
                DisplayName = string.IsNullOrWhiteSpace(user.Name) ? user.Username : user.Name,
            },
            // Don't let the same authenticator enrol twice for one account.
            ExcludeCredentials = existing
                .Select(c => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(c.CredentialId)))
                .ToList(),
            AuthenticatorSelection = new AuthenticatorSelection
            {
                // Platform authenticator + a real user-verification gesture: that's
                // what makes this a biometric gate rather than mere presence.
                AuthenticatorAttachment = AuthenticatorAttachment.Platform,
                UserVerification = UserVerificationRequirement.Required,
                ResidentKey = ResidentKeyRequirement.Discouraged,
            },
            AttestationPreference = AttestationConveyancePreference.None,
        });

        _challenges.PutCreate(user.Id.ToString(), options.ToJson(), party);
        return options;
    }

    /// <summary>Null on success, else why the registration was refused.</summary>
    public async Task<string?> RegisterVerifyAsync(
        User user, AuthenticatorAttestationRawResponse response, string? name, RelyingParty party, CancellationToken ct)
    {
        var pending = _challenges.TakeCreate(user.Id.ToString());
        if (pending is null) return "The registration prompt expired. Try again.";
        // Answered from a different address than it was asked on.
        if (pending.Party != party) return "The registration was answered from a different address. Try again.";
        var options = CredentialCreateOptions.FromJson(pending.OptionsJson);

        var result = await For(party).MakeNewCredentialAsync(new MakeNewCredentialParams
        {
            AttestationResponse = response,
            OriginalOptions = options,
            IsCredentialIdUniqueToUserCallback = async (args, innerCt) =>
            {
                var id = Base64Url.EncodeToString(args.CredentialId);
                return !await _db.WebAuthnCredentials.AnyAsync(c => c.CredentialId == id, innerCt);
            },
        }, ct);

        var label = string.IsNullOrWhiteSpace(name) ? "Device" : name.Trim();
        _db.WebAuthnCredentials.Add(new WebAuthnCredential
        {
            UserId = user.Id,
            CredentialId = Base64Url.EncodeToString(result.Id),
            PublicKey = Convert.ToBase64String(result.PublicKey),
            SignCount = result.SignCount,
            Name = label.Length > 60 ? label[..60] : label,
            CreatedUtc = DateTime.UtcNow,
            RpId = party.RpId,
        });
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation("WebAuthn credential registered for user {UserId} at {RpId}", user.Id, party.RpId);
        return null;
    }

    // ── Assertion (the unlock gesture) ──────────────────────────────────────────

    /// <summary>Null when no credential of this user can be used at this address.</summary>
    public async Task<AssertionOptions?> AssertChallengeAsync(int userId, RelyingParty party, CancellationToken ct)
    {
        var credentials = (await _db.WebAuthnCredentials.Where(c => c.UserId == userId).ToListAsync(ct))
            .Where(c => UsableAt(c, party))
            .ToList();
        if (credentials.Count == 0) return null;

        var options = For(party).GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = credentials
                .Select(c => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(c.CredentialId)))
                .ToList(),
            UserVerification = UserVerificationRequirement.Required,
        });

        _challenges.PutAssert(userId.ToString(), options.ToJson(), party);
        return options;
    }

    // Verifies the assertion and, on success, mints a short-lived unlock token.
    // Returns null when verification fails for any reason.
    public async Task<string?> AssertVerifyAsync(
        int userId, AuthenticatorAssertionRawResponse response, RelyingParty party, CancellationToken ct)
    {
        var pending = _challenges.TakeAssert(userId.ToString());
        if (pending is null || pending.Party != party) return null;
        var options = AssertionOptions.FromJson(pending.OptionsJson);

        // The raw assertion carries its credential id already base64url-encoded —
        // the same form `Base64Url.EncodeToString` produced at registration. The
        // lookup is scoped to the caller, so another user's credential can never
        // unlock this session.
        var credentialId = response.Id;
        var stored = await _db.WebAuthnCredentials
            .FirstOrDefaultAsync(c => c.CredentialId == credentialId && c.UserId == userId, ct);
        if (stored is null || !UsableAt(stored, party)) return null;

        VerifyAssertionResult result;
        try
        {
            result = await For(party).MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = response,
                OriginalOptions = options,
                StoredPublicKey = Convert.FromBase64String(stored.PublicKey),
                StoredSignatureCounter = stored.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (args, _) =>
                    Task.FromResult(Encoding.UTF8.GetString(args.UserHandle) == userId.ToString()),
            }, ct);
        }
        catch (Fido2VerificationException ex)
        {
            _logger.LogWarning(ex, "WebAuthn assertion failed for user {UserId}", userId);
            return null;
        }

        // Advance the replay counter the library validated for us, and pin a legacy
        // credential to the host it has now proven it works on.
        stored.SignCount = result.SignCount;
        stored.LastUsedUtc = DateTime.UtcNow;
        if (stored.RpId.Length == 0) stored.RpId = party.RpId;
        await _db.SaveChangesAsync(ct);

        return _unlockTokens.Issue(userId.ToString());
    }
}
