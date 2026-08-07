using System.Buffers.Text;
using System.Text;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// WebAuthn gatekeeper. Wraps Fido2NetLib to register platform authenticators
// (Touch ID / Face ID / Windows Hello) and verify assertions. All signature,
// challenge, origin and replay-counter checking is delegated to the library —
// never hand-rolled.
//
// Request-scoped (IFido2 and the DbContext are), so the pending challenges live in
// the singleton WebAuthnChallengeStore. Challenges are single-use: the blob issued
// by `...ChallengeAsync` is consumed by the matching `...VerifyAsync`, so a replayed
// or mismatched challenge can't verify.
public sealed class BiometricAuthService
{
    private readonly IFido2 _fido2;
    private readonly AppDbContext _db;
    private readonly WebAuthnChallengeStore _challenges;
    private readonly UnlockTokenStore _unlockTokens;
    private readonly ILogger<BiometricAuthService> _logger;

    public BiometricAuthService(
        IFido2 fido2,
        AppDbContext db,
        WebAuthnChallengeStore challenges,
        UnlockTokenStore unlockTokens,
        ILogger<BiometricAuthService> logger)
    {
        _fido2 = fido2;
        _db = db;
        _challenges = challenges;
        _unlockTokens = unlockTokens;
        _logger = logger;
    }

    // ── Registration ────────────────────────────────────────────────────────────

    public async Task<CredentialCreateOptions> RegisterChallengeAsync(User user, CancellationToken ct)
    {
        var existing = await _db.WebAuthnCredentials.Where(c => c.UserId == user.Id).ToListAsync(ct);
        var options = _fido2.RequestNewCredential(new RequestNewCredentialParams
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

        _challenges.PutCreate(user.Id.ToString(), options.ToJson());
        return options;
    }

    public async Task<bool> RegisterVerifyAsync(
        User user, AuthenticatorAttestationRawResponse response, string? name, CancellationToken ct)
    {
        var optionsJson = _challenges.TakeCreate(user.Id.ToString());
        if (optionsJson is null) return false;
        var options = CredentialCreateOptions.FromJson(optionsJson);

        var result = await _fido2.MakeNewCredentialAsync(new MakeNewCredentialParams
        {
            AttestationResponse = response,
            OriginalOptions = options,
            IsCredentialIdUniqueToUserCallback = async (args, innerCt) =>
            {
                var id = Base64Url.EncodeToString(args.CredentialId);
                return !await _db.WebAuthnCredentials.AnyAsync(c => c.CredentialId == id, innerCt);
            },
        }, ct);

        _db.WebAuthnCredentials.Add(new WebAuthnCredential
        {
            UserId = user.Id,
            CredentialId = Base64Url.EncodeToString(result.Id),
            PublicKey = Convert.ToBase64String(result.PublicKey),
            SignCount = result.SignCount,
            Name = string.IsNullOrWhiteSpace(name) ? "Device" : name.Trim(),
            CreatedUtc = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation("WebAuthn credential registered for user {UserId}", user.Id);
        return true;
    }

    // ── Assertion (the unlock gesture) ──────────────────────────────────────────

    public async Task<AssertionOptions?> AssertChallengeAsync(int userId, CancellationToken ct)
    {
        var credentials = await _db.WebAuthnCredentials.Where(c => c.UserId == userId).ToListAsync(ct);
        if (credentials.Count == 0) return null; // nothing enrolled → nothing to assert

        var options = _fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = credentials
                .Select(c => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(c.CredentialId)))
                .ToList(),
            UserVerification = UserVerificationRequirement.Required,
        });

        _challenges.PutAssert(userId.ToString(), options.ToJson());
        return options;
    }

    // Verifies the assertion and, on success, mints a short-lived unlock token.
    // Returns null when verification fails for any reason.
    public async Task<string?> AssertVerifyAsync(
        int userId, AuthenticatorAssertionRawResponse response, CancellationToken ct)
    {
        var optionsJson = _challenges.TakeAssert(userId.ToString());
        if (optionsJson is null) return null;
        var options = AssertionOptions.FromJson(optionsJson);

        // The raw assertion carries its credential id already base64url-encoded —
        // the same form `Base64Url.EncodeToString` produced at registration. The
        // lookup is scoped to the caller, so another user's credential can never
        // unlock this session.
        var credentialId = response.Id;
        var stored = await _db.WebAuthnCredentials
            .FirstOrDefaultAsync(c => c.CredentialId == credentialId && c.UserId == userId, ct);
        if (stored is null) return null;

        VerifyAssertionResult result;
        try
        {
            result = await _fido2.MakeAssertionAsync(new MakeAssertionParams
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

        // Advance the replay counter the library validated for us.
        stored.SignCount = result.SignCount;
        stored.LastUsedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);

        return _unlockTokens.Issue(userId.ToString());
    }
}
