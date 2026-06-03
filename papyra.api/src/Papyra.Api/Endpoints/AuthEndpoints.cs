using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Api.Endpoints;

// ── AuthEndpoints ─────────────────────────────────────────────────────────────
// All public and auth-gated auth endpoints.
// POST /api/auth/resend-verification, POST /api/auth/forgot-password,
// POST /api/auth/reset-password-token.

public static class AuthEndpoints
{
    public static void Map(WebApplication app)
    {
        // ── Setup ─────────────────────────────────────────────────────────────
        app.MapPost("/api/auth/setup",
            async (SetupRequest req, UserService users, AuditService audit, HttpContext ctx) =>
        {
            if (users.IsInitialized())
                return Results.Conflict(new { error = "System already initialized." });

            if (string.IsNullOrWhiteSpace(req.Username) ||
                string.IsNullOrWhiteSpace(req.Password))
                return Results.BadRequest(new { error = "Username and password are required." });

            var normalizedSetup = req.Username.Trim().ToLowerInvariant();
            if (!UserService.IsValidUsername(normalizedSetup))
                return Results.BadRequest(new { error = "Username may only contain letters, digits, hyphens, underscores, and dots (max 50 chars)." });

            var user = new UserModel
            {
                Username     = normalizedSetup,
                Name         = req.Name?.Trim() ?? req.Username,
                Email        = req.Email?.Trim() ?? string.Empty,
                PasswordHash = users.HashPassword(req.Password),
                Role         = "admin",
            };

            await users.SaveUserAsync(user);
            await SignIn(ctx, user);
            audit.Log("setup_complete", user.Username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(ToProfile(user));
        })
        .WithName("Setup")
        .WithSummary("Create the first admin user and establish a session")
        .WithTags("Auth");

        // ── Login ─────────────────────────────────────────────────────────────
        // Rate-limited: 5 failures / 15 min / IP.
        // Transparently re-hashes PBKDF2 passwords → bcrypt on successful login.
        // If 2FA is enabled returns 202 with a temporary mfaToken.
        app.MapPost("/api/auth/login",
            async (LoginRequest req, UserService users, PendingMfaStore mfaStore,
                   AuthRateLimiter rateLimiter, AuditService audit,
                   GlobalSettingsService globalSettings, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(req.Username) ||
                string.IsNullOrWhiteSpace(req.Password))
                return Results.BadRequest(new { error = "Username and password are required." });

            var ip = AuthRateLimiter.GetIp(ctx);

            if (rateLimiter.IsBlocked(ip))
                return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            var user = await users.GetUserAsync(req.Username.Trim());
            if (user is null || !users.VerifyPassword(req.Password, user.PasswordHash))
            {
                rateLimiter.RecordFailure(ip);
                audit.Log("login_failure", req.Username.Trim(), ip);
                return Results.Unauthorized();
            }

            // Upgrade legacy PBKDF2 hash → bcrypt on the next successful login
            if (UserService.NeedsRehash(user.PasswordHash))
            {
                user.PasswordHash = users.HashPassword(req.Password);
                await users.SaveUserAsync(user);
            }

            rateLimiter.Reset(ip);

            // ── Email verification gate ──────────────────────────────────────
            // If the instance requires email verification and this user hasn't verified,
            // block login and prompt them to check their inbox.
            var globalCfg = await globalSettings.GetAsync();
            if (globalCfg.RequireEmailVerification && !user.EmailVerified)
            {
                audit.Log("login_failure", user.Username, ip, "email_not_verified");
                return Results.Json(
                    new { error = "Please verify your email address before logging in.", requiresEmailVerification = true },
                    statusCode: StatusCodes.Status403Forbidden);
            }

            if (user.TwoFactorEnabled)
            {
                audit.Log("login_2fa_required", user.Username, ip);
                var mfaToken = mfaStore.Create(user.Username);
                return Results.Accepted(value: new
                {
                    requiresTwoFactor = true,
                    mfaToken,
                });
            }

            await SignIn(ctx, user);
            audit.Log("login_success", user.Username, ip);
            return Results.Ok(ToProfile(user));
        })
        .WithName("Login")
        .WithSummary("Authenticate; returns 202 + mfaToken if 2FA is enabled")
        .WithTags("Auth");

        // ── Logout ────────────────────────────────────────────────────────────
        app.MapPost("/api/auth/logout", async (HttpContext ctx, AuditService audit) =>
        {
            var username = ctx.User.Identity?.Name ?? "unknown";
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            audit.Log("logout", username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { message = "Signed out." });
        })
        .WithName("Logout")
        .WithSummary("Clear the session cookie")
        .WithTags("Auth");

        // ── Me ────────────────────────────────────────────────────────────────
        app.MapGet("/api/auth/me",
            async (HttpContext ctx, UserService users, GlobalSettingsService globalSettings) =>
        {
            var isInitialized = users.IsInitialized();

            if (ctx.User.Identity?.IsAuthenticated != true)
            {
                var settings = await globalSettings.GetAsync();
                return Results.Ok(new
                {
                    isAuthenticated           = false,
                    isInitialized,
                    allowSelfRegistration     = settings.AllowSelfRegistration,
                    requireEmailVerification  = settings.RequireEmailVerification,
                });
            }

            var username = ctx.User.Identity.Name!;
            var user     = await users.GetUserAsync(username);

            if (user is null)
                return Results.Ok(new { isAuthenticated = false, isInitialized });

            return Results.Ok(new
            {
                isAuthenticated   = true,
                isInitialized,
                username          = user.Username,
                name              = user.Name,
                email             = user.Email,
                role              = user.Role,
                twoFactorEnabled  = user.TwoFactorEnabled,
                mustResetPassword = user.MustResetPassword,
            });
        })
        .WithName("Me")
        .WithSummary("Returns current user profile and system initialization status")
        .WithTags("Auth");

        // ── Register ──────────────────────────────────────────────────────────
        // Public endpoint — only works when AllowSelfRegistration is enabled.
        // When RequireEmailVerification is on, saves a token and sends a verification email.
        app.MapPost("/api/auth/register",
            async (RegisterRequest req, UserService users,
                   GlobalSettingsService globalSettings, EmailService emailSvc,
                   AuditService audit, HttpContext ctx) =>
        {
            var settings = await globalSettings.GetAsync();
            if (!settings.AllowSelfRegistration)
                return Results.Json(
                    new { error = "Self-registration is not enabled on this instance." },
                    statusCode: StatusCodes.Status403Forbidden);

            if (string.IsNullOrWhiteSpace(req.Username) ||
                string.IsNullOrWhiteSpace(req.Password))
                return Results.BadRequest(new { error = "Username and password are required." });

            if (req.Password.Length < 8)
                return Results.BadRequest(new { error = "Password must be at least 8 characters." });

            var normalised = req.Username.Trim().ToLowerInvariant();

            if (!UserService.IsValidUsername(normalised))
                return Results.BadRequest(new { error = "Username may only contain letters, digits, hyphens, underscores, and dots (max 50 chars)." });

            if (await users.GetUserAsync(normalised) is not null)
                return Results.Conflict(new { error = "Username is already taken." });

            var user = new UserModel
            {
                Username     = normalised,
                Name         = req.Name?.Trim() is { Length: > 0 } n ? n : normalised,
                Email        = req.Email?.Trim() ?? string.Empty,
                PasswordHash = users.HashPassword(req.Password),
                Role         = "member",
            };

            bool requiresVerification = settings.RequireEmailVerification
                && !string.IsNullOrWhiteSpace(user.Email);

            if (requiresVerification)
            {
                var (token, hash, expiry) = TokenService.Generate(TokenService.EmailVerificationLifetime);
                user.EmailVerificationTokenHash   = hash;
                user.EmailVerificationTokenExpiry = expiry;
                user.EmailVerified = false;
                await users.SaveUserAsync(user);

                // Best-effort email send — if SMTP is not configured, user can request resend later
                try
                {
                    var baseUrl = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
                    await emailSvc.SendAsync(user.Email,
                        "Papyra — Verify your email address",
                        BuildVerificationEmail(user.Name, baseUrl, token));
                }
                catch { /* SMTP not configured or transient; user can request resend */ }

                audit.Log("register", user.Username, AuthRateLimiter.GetIp(ctx), "email_verification_pending");
                return Results.Ok(new { requiresEmailVerification = true });
            }

            user.EmailVerified = true;
            await users.SaveUserAsync(user);
            await SignIn(ctx, user);
            audit.Log("register", user.Username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(ToProfile(user));
        })
        .WithName("Register")
        .WithSummary("Self-register a new member account (requires AllowSelfRegistration)")
        .WithTags("Auth");

        // ── Verify Email ──────────────────────────────────────────────────────
        // Consumes the one-time token from the verification link and marks the user verified.
        app.MapPost("/api/auth/verify-email",
            async (VerifyEmailRequest req, UserService users, AuditService audit, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(req.Token))
                return Results.BadRequest(new { error = "Token is required." });

            // Find user by scanning — verification is infrequent, scan is acceptable
            UserModel? target = null;
            foreach (var username in users.GetAllUsernames())
            {
                var u = await users.GetUserAsync(username);
                if (u is null) continue;

                if (TokenService.IsValid(req.Token, u.EmailVerificationTokenHash, u.EmailVerificationTokenExpiry))
                {
                    target = u;
                    break;
                }
            }

            if (target is null)
                return Results.BadRequest(new { error = "Invalid or expired verification link." });

            // Invalidate the token and mark verified
            target.EmailVerified                = true;
            target.EmailVerificationTokenHash   = null;
            target.EmailVerificationTokenExpiry = 0;
            await users.SaveUserAsync(target);

            audit.Log("email_verified", target.Username, AuthRateLimiter.GetIp(ctx));
            await SignIn(ctx, target);
            return Results.Ok(ToProfile(target));
        })
        .WithName("VerifyEmail")
        .WithSummary("Consume an email verification token and mark the account verified")
        .WithTags("Auth");

        // ── Resend Verification ───────────────────────────────────────────────
        // Rate-limited 5 req/15 min per IP. Always returns 200 to avoid user enumeration.
        app.MapPost("/api/auth/resend-verification",
            async (ResendVerificationRequest req, UserService users,
                   GlobalSettingsService globalSettings, EmailService emailSvc,
                   AuthRateLimiter rateLimiter, AuditService audit, HttpContext ctx) =>
        {
            var ip = AuthRateLimiter.GetIp(ctx);

            if (rateLimiter.IsBlocked(ip))
                return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            if (string.IsNullOrWhiteSpace(req.Username))
                return Results.Ok(new { message = "If that account exists, a new verification email has been sent." });

            var username = req.Username.Trim().ToLowerInvariant();
            var user = await users.GetUserAsync(username);

            // Silently succeed regardless of whether user exists (enumeration guard)
            if (user is not null && !user.EmailVerified && !string.IsNullOrWhiteSpace(user.Email))
            {
                var (token, hash, expiry) = TokenService.Generate(TokenService.EmailVerificationLifetime);
                user.EmailVerificationTokenHash   = hash;
                user.EmailVerificationTokenExpiry = expiry;
                await users.SaveUserAsync(user);

                try
                {
                    var baseUrl = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
                    await emailSvc.SendAsync(user.Email,
                        "Papyra — Verify your email address",
                        BuildVerificationEmail(user.Name, baseUrl, token));
                }
                catch { /* best-effort */ }

                audit.Log("email_verification_resent", username, ip);
            }

            return Results.Ok(new { message = "If that account exists, a new verification email has been sent." });
        })
        .WithName("ResendVerification")
        .WithSummary("Resend email verification link (always 200 to prevent enumeration)")
        .WithTags("Auth");

        // ── Forgot Password ───────────────────────────────────────────────────
        // Always 200 to prevent user enumeration.
        // Rate-limited 5 req/15 min per IP to prevent SMTP flooding.
        app.MapPost("/api/auth/forgot-password",
            async (ForgotPasswordRequest req, UserService users,
                   EmailService emailSvc, AuthRateLimiter rateLimiter,
                   AuditService audit, HttpContext ctx) =>
        {
            const string ok = "If that email address is registered, you will receive a password reset link shortly.";

            var ip = AuthRateLimiter.GetIp(ctx);

            if (rateLimiter.IsBlocked(ip))
                return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            if (!string.IsNullOrWhiteSpace(req.Email))
            {
                var email = req.Email.Trim().ToLowerInvariant();

                // Find user by email (scan — infrequent operation)
                UserModel? target = null;
                foreach (var username in users.GetAllUsernames())
                {
                    var u = await users.GetUserAsync(username);
                    if (u is not null &&
                        u.Email.Equals(email, StringComparison.OrdinalIgnoreCase))
                    {
                        target = u;
                        break;
                    }
                }

                if (target is not null)
                {
                    var (token, hash, expiry) = TokenService.Generate(TokenService.PasswordResetLifetime);
                    target.PasswordResetTokenHash   = hash;
                    target.PasswordResetTokenExpiry = expiry;
                    await users.SaveUserAsync(target);

                    try
                    {
                        var baseUrl = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
                        await emailSvc.SendAsync(target.Email,
                            "Papyra — Password reset request",
                            BuildPasswordResetEmail(target.Name, baseUrl, token));
                    }
                    catch { /* best-effort */ }

                    audit.Log("password_reset_requested", target.Username, ip);
                }
            }

            return Results.Ok(new { message = ok });
        })
        .WithName("ForgotPassword")
        .WithSummary("Request a password-reset email (always 200 to prevent enumeration)")
        .WithTags("Auth");

        // ── Reset Password via Token ───────────────────────────────────────────
        // Consumes the single-use reset token from the email link.
        app.MapPost("/api/auth/reset-password-token",
            async (ResetPasswordTokenRequest req, UserService users,
                   AuditService audit, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(req.Token))
                return Results.BadRequest(new { error = "Token is required." });

            if (string.IsNullOrWhiteSpace(req.NewPassword) || req.NewPassword.Length < 8)
                return Results.BadRequest(new { error = "New password must be at least 8 characters." });

            if (req.NewPassword != req.ConfirmPassword)
                return Results.BadRequest(new { error = "Passwords do not match." });

            UserModel? target = null;
            foreach (var username in users.GetAllUsernames())
            {
                var u = await users.GetUserAsync(username);
                if (u is null) continue;

                if (TokenService.IsValid(req.Token, u.PasswordResetTokenHash, u.PasswordResetTokenExpiry))
                {
                    target = u;
                    break;
                }
            }

            if (target is null)
                return Results.BadRequest(new { error = "Invalid or expired reset link." });

            // Consume the token and update password
            target.PasswordHash              = users.HashPassword(req.NewPassword);
            target.PasswordResetTokenHash    = null;
            target.PasswordResetTokenExpiry  = 0;
            target.MustResetPassword         = false;
            await users.SaveUserAsync(target);

            audit.Log("password_reset_token", target.Username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { message = "Password has been reset. You can now log in." });
        })
        .WithName("ResetPasswordToken")
        .WithSummary("Consume a single-use reset token and set a new password")
        .WithTags("Auth");

        // ── Reset Password ────────────────────────────────────────────────────
        // Authenticated — lets a user change their own password and clears MustResetPassword.
        app.MapPost("/api/auth/reset-password",
            async (ResetPasswordRequest req, UserService users,
                   AuditService audit, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name;
            if (username is null) return Results.Unauthorized();

            if (string.IsNullOrWhiteSpace(req.NewPassword) || req.NewPassword.Length < 8)
                return Results.BadRequest(new { error = "New password must be at least 8 characters." });

            if (req.NewPassword != req.ConfirmPassword)
                return Results.BadRequest(new { error = "Passwords do not match." });

            var user = await users.GetUserAsync(username);
            if (user is null) return Results.Unauthorized();

            user.PasswordHash     = users.HashPassword(req.NewPassword);
            user.MustResetPassword = false;
            await users.SaveUserAsync(user);

            audit.Log("password_reset", username, AuthRateLimiter.GetIp(ctx));
            return Results.Ok(new { message = "Password updated." });
        })
        .RequireAuthorization()
        .WithName("ResetPassword")
        .WithSummary("Change the current user's password and clear MustResetPassword flag")
        .WithTags("Auth");
    }

    internal static Task SignIn(HttpContext ctx, UserModel user)
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

    private static object ToProfile(UserModel u) =>
        new { username = u.Username, name = u.Name, email = u.Email, role = u.Role,
              mustResetPassword = u.MustResetPassword };

    // ── Email template helpers ────────────────────────────────────────────────

    private static string BuildVerificationEmail(string name, string baseUrl, string token) => $"""
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:32px">
          <h2 style="color:#7aaa8a">Verify your Papyra email address</h2>
          <p>Hi {System.Net.WebUtility.HtmlEncode(name)},</p>
          <p>Click the button below to verify your email address and activate your account.
             This link expires in 24&nbsp;hours.</p>
          <p style="text-align:center;margin:32px 0">
            <a href="{baseUrl}/verify-email?token={Uri.EscapeDataString(token)}"
               style="background:#7aaa8a;color:#0f2118;padding:12px 28px;border-radius:6px;
                      text-decoration:none;font-weight:600">
              Verify email address
            </a>
          </p>
          <p style="color:#888;font-size:13px">If you did not create a Papyra account, ignore this email.</p>
        </div>
        """;

    private static string BuildPasswordResetEmail(string name, string baseUrl, string token) => $"""
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:32px">
          <h2 style="color:#7aaa8a">Reset your Papyra password</h2>
          <p>Hi {System.Net.WebUtility.HtmlEncode(name)},</p>
          <p>Click the button below to reset your password.
             This link expires in 1&nbsp;hour and can only be used once.</p>
          <p style="text-align:center;margin:32px 0">
            <a href="{baseUrl}/reset-password-token?token={Uri.EscapeDataString(token)}"
               style="background:#7aaa8a;color:#0f2118;padding:12px 28px;border-radius:6px;
                      text-decoration:none;font-weight:600">
              Reset password
            </a>
          </p>
          <p style="color:#888;font-size:13px">If you did not request a password reset, ignore this email.</p>
        </div>
        """;
}

record SetupRequest(string Username, string? Name, string? Email, string Password);
record LoginRequest(string Username, string Password);
record RegisterRequest(string Username, string Password, string? Name, string? Email);
record ResetPasswordRequest(string NewPassword, string ConfirmPassword);
record VerifyEmailRequest(string Token);
record ResendVerificationRequest(string? Username);
record ForgotPasswordRequest(string? Email);
record ResetPasswordTokenRequest(string Token, string NewPassword, string ConfirmPassword);
