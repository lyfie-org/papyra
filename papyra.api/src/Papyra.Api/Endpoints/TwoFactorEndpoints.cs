using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Api.Endpoints;

// In-memory store for pending 2FA challenges.
// Keyed by a random token; auto-expires after 5 minutes.
public sealed class PendingMfaStore
{
    private readonly ConcurrentDictionary<string, (string Username, DateTimeOffset ExpiresAt)> _store = new();

    public string Create(string username)
    {
        Cleanup();
        var token = Guid.NewGuid().ToString("N");
        _store[token] = (username, DateTimeOffset.UtcNow.AddMinutes(5));
        return token;
    }

    public string? Consume(string token)
    {
        if (_store.TryRemove(token, out var entry) && entry.ExpiresAt > DateTimeOffset.UtcNow)
            return entry.Username;
        return null;
    }

    private void Cleanup()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var kv in _store.Where(kv => kv.Value.ExpiresAt <= now).ToList())
            _store.TryRemove(kv.Key, out _);
    }
}

public static class TwoFactorEndpoints
{
    public static void Map(WebApplication app)
    {
        // ── POST /api/auth/2fa/enable ─────────────────────────────────────────
        // Generates a new TOTP secret (encrypted at rest) and returns the
        // plaintext secret + otpauth URI. Does NOT activate 2FA until /confirm.
        app.MapPost("/api/auth/2fa/enable",
            async (UserService users, TotpService totp, EncryptionService enc,
                   AuditService audit, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name;
            if (username is null) return Results.Unauthorized();

            var user = await users.GetUserAsync(username);
            if (user is null) return Results.Unauthorized();

            if (!enc.HasKey)
                return Results.Problem(
                    "PAPYRA_DATA_KEY is not configured. Cannot enable 2FA until an encryption key is set.",
                    statusCode: StatusCodes.Status503ServiceUnavailable);

            var secret = totp.GenerateSecret();
            user.TwoFactorSecretEnc = enc.Encrypt(secret);
            user.TwoFactorSecret    = null; // clear any legacy plaintext
            user.TwoFactorEnabled   = false; // pending confirmation
            await users.SaveUserAsync(user);

            audit.Log("2fa_enable_started", username, AuthRateLimiter.GetIp(ctx));
            var uri = totp.GetOtpAuthUri(secret, username);
            return Results.Ok(new { secret, otpAuthUri = uri });
        })
        .RequireAuthorization()
        .WithName("2faEnable")
        .WithSummary("Generate an encrypted TOTP secret (requires /2fa/confirm to activate)")
        .WithTags("Auth");

        // ── POST /api/auth/2fa/confirm ────────────────────────────────────────
        // Validates the first code, activates 2FA, and returns 8 recovery codes
        // (one-time display — never retrievable again).
        app.MapPost("/api/auth/2fa/confirm",
            async (ConfirmTwoFactorRequest req, UserService users, TotpService totp,
                   EncryptionService enc, AuditService audit, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name;
            if (username is null) return Results.Unauthorized();

            var user = await users.GetUserAsync(username);
            if (user is null) return Results.Unauthorized();

            var secret = await ResolveSecretAsync(user, enc, users);
            if (secret is null)
                return Results.BadRequest(new { error = "2FA setup not started." });

            if (!totp.ValidateCode(secret, req.Code))
                return Results.BadRequest(new { error = "Invalid code." });

            // Generate 8 single-use recovery codes; store bcrypt hashes only.
            var plainCodes = totp.GenerateRecoveryCodes(8);
            user.RecoveryCodes = plainCodes
                .Select(c => new RecoveryCodeEntry
                {
                    CodeHash = BCrypt.Net.BCrypt.HashPassword(c, workFactor: 10),
                })
                .ToList();
            user.TwoFactorEnabled = true;
            await users.SaveUserAsync(user);

            audit.Log("2fa_enabled", username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { message = "2FA enabled.", recoveryCodes = plainCodes });
        })
        .RequireAuthorization()
        .WithName("2faConfirm")
        .WithSummary("Confirm TOTP setup; returns one-time recovery codes")
        .WithTags("Auth");

        // ── POST /api/auth/2fa/disable ────────────────────────────────────────
        // Requires a valid current TOTP code to disable 2FA.
        app.MapPost("/api/auth/2fa/disable",
            async (ConfirmTwoFactorRequest req, UserService users, TotpService totp,
                   EncryptionService enc, AuditService audit, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name;
            if (username is null) return Results.Unauthorized();

            var user = await users.GetUserAsync(username);
            if (user is null || !user.TwoFactorEnabled)
                return Results.BadRequest(new { error = "2FA is not enabled." });

            var secret = await ResolveSecretAsync(user, enc, users);
            if (secret is null || !totp.ValidateCode(secret, req.Code))
                return Results.BadRequest(new { error = "Invalid code." });

            user.TwoFactorSecretEnc = null;
            user.TwoFactorSecret    = null;
            user.TwoFactorEnabled   = false;
            user.RecoveryCodes      = null;
            await users.SaveUserAsync(user);

            audit.Log("2fa_disabled", username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { message = "2FA disabled." });
        })
        .RequireAuthorization()
        .WithName("2faDisable")
        .WithSummary("Disable TOTP 2FA (requires a valid current code)")
        .WithTags("Auth");

        // ── POST /api/auth/2fa/regenerate-recovery-codes ─────────────────────
        // Generates 8 new recovery codes (invalidates the old set). Requires a
        // valid current TOTP code.
        app.MapPost("/api/auth/2fa/regenerate-recovery-codes",
            async (ConfirmTwoFactorRequest req, UserService users, TotpService totp,
                   EncryptionService enc, AuditService audit, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name;
            if (username is null) return Results.Unauthorized();

            var user = await users.GetUserAsync(username);
            if (user is null || !user.TwoFactorEnabled)
                return Results.BadRequest(new { error = "2FA is not enabled." });

            var secret = await ResolveSecretAsync(user, enc, users);
            if (secret is null || !totp.ValidateCode(secret, req.Code))
                return Results.BadRequest(new { error = "Invalid code." });

            var plainCodes = totp.GenerateRecoveryCodes(8);
            user.RecoveryCodes = plainCodes
                .Select(c => new RecoveryCodeEntry
                {
                    CodeHash = BCrypt.Net.BCrypt.HashPassword(c, workFactor: 10),
                })
                .ToList();
            await users.SaveUserAsync(user);

            audit.Log("2fa_recovery_regenerated", username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { recoveryCodes = plainCodes });
        })
        .RequireAuthorization()
        .WithName("2faRegenerateRecoveryCodes")
        .WithSummary("Regenerate 2FA recovery codes (requires current TOTP code)")
        .WithTags("Auth");

        // ── POST /api/auth/2fa/verify ─────────────────────────────────────────
        // Completes a login that required 2FA. Accepts either a TOTP code or a
        // single-use recovery code. Rate-limited: 5 failures / 15 min / IP.
        app.MapPost("/api/auth/2fa/verify",
            async (VerifyTwoFactorRequest req, UserService users, TotpService totp,
                   EncryptionService enc, PendingMfaStore mfaStore,
                   AuthRateLimiter rateLimiter, AuditService audit, HttpContext ctx) =>
        {
            var ip = AuthRateLimiter.GetIp(ctx);

            if (rateLimiter.IsBlocked(ip))
                return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            var username = mfaStore.Consume(req.MfaToken);
            if (username is null)
                return Results.BadRequest(new { error = "Invalid or expired MFA token." });

            var user = await users.GetUserAsync(username);
            if (user is null || !user.TwoFactorEnabled)
                return Results.BadRequest(new { error = "2FA state mismatch." });

            // Try TOTP code first
            var secret   = await ResolveSecretAsync(user, enc, users);
            var validated = secret is not null && totp.ValidateCode(secret, req.Code);
            var usedRecovery = false;

            // Fall back to a recovery code if TOTP failed
            if (!validated && user.RecoveryCodes is not null)
            {
                var entry = user.RecoveryCodes.FirstOrDefault(rc =>
                    rc.UsedAt is null && BCrypt.Net.BCrypt.Verify(req.Code, rc.CodeHash));

                if (entry is not null)
                {
                    entry.UsedAt = DateTime.UtcNow;
                    await users.SaveUserAsync(user);
                    validated    = true;
                    usedRecovery = true;
                }
            }

            if (!validated)
            {
                rateLimiter.RecordFailure(ip);
                audit.Log("2fa_failure", username, ip);
                return Results.Unauthorized();
            }

            rateLimiter.Reset(ip);
            audit.Log(usedRecovery ? "2fa_recovery_used" : "2fa_success", username, ip);

            await SignIn(ctx, user);
            return Results.Ok(new
            {
                username = user.Username,
                name     = user.Name,
                email    = user.Email,
                role     = user.Role,
            });
        })
        .WithName("2faVerify")
        .WithSummary("Complete 2FA login with TOTP code or recovery code")
        .WithTags("Auth");
    }

    // Decrypts the TOTP secret, transparently migrating legacy plaintext on first access.
    private static async Task<string?> ResolveSecretAsync(
        UserModel user, EncryptionService enc, UserService users)
    {
        if (user.TwoFactorSecretEnc is not null)
        {
            try { return enc.Decrypt(user.TwoFactorSecretEnc); }
            catch { return null; }
        }

        // One-time migration: legacy plaintext secret → encrypt and save
        if (user.TwoFactorSecret is not null && enc.HasKey)
        {
            var plaintext = user.TwoFactorSecret;
            user.TwoFactorSecretEnc = enc.Encrypt(plaintext);
            user.TwoFactorSecret    = null;
            await users.SaveUserAsync(user);
            return plaintext;
        }

        return null;
    }

    private static Task SignIn(HttpContext ctx, UserModel user)
    {
        Claim[] claims =
        [
            new(ClaimTypes.Name,  user.Username),
            new(ClaimTypes.Role,  user.Role),
            new("name",           user.Name),
            new("email",          user.Email),
        ];
        var identity   = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
        var principal  = new ClaimsPrincipal(identity);
        var properties = new AuthenticationProperties { IsPersistent = true };
        return ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal, properties);
    }
}

record ConfirmTwoFactorRequest(string Code);
record VerifyTwoFactorRequest(string MfaToken, string Code);
