using System.IO.Compression;
using System.Security.Claims;
using Papyra.Api.Models;
using Papyra.Api.Services;
using static Papyra.Api.Services.RoleService;
using System.Text.Json;


namespace Papyra.Api.Endpoints;

public static class AdminEndpoints
{
    public static void Map(WebApplication app)
    {
        // ── GET /api/admin/users ──────────────────────────────────────────────
        app.MapGet("/api/admin/users", async (UserService users, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            var result = new List<object>();
            foreach (var username in users.GetAllUsernames())
            {
                var user = await users.GetUserAsync(username);
                if (user is not null) result.Add(Sanitize(user));
            }
            return Results.Ok(result);
        })
        .RequireAuthorization()
        .WithName("AdminListUsers")
        .WithSummary("List all user profiles (no password hashes)")
        .WithTags("Admin");

        // ── PUT /api/admin/users/{username}/role ──────────────────────────────
        app.MapPut("/api/admin/users/{username}/role",
            async (string username, ChangeRoleRequest req, UserService users,
                   AuditService audit, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            var user = await users.GetUserAsync(username);
            if (user is null) return Results.NotFound(new { error = "User not found." });

            if (!string.IsNullOrWhiteSpace(req.Role))
            {
                if (!AllowedRoles.Contains(req.Role.Trim().ToLowerInvariant()))
                    return Results.BadRequest(new { error = $"Unknown role '{req.Role}'." });

                var prevRole = user.Role;
                user.Role = req.Role.Trim().ToLowerInvariant();
                audit.Log("role_change", username, AuthRateLimiter.GetIp(ctx),
                    $"admin={ctx.User.Identity?.Name} {prevRole}→{user.Role}");
            }

            await users.SaveUserAsync(user);
            return Results.Ok(Sanitize(user));
        })
        .RequireAuthorization()
        .WithName("AdminChangeRole")
        .WithSummary("Change a user's role")
        .WithTags("Admin");

        // ── PUT /api/admin/roles/{roleName} ───────────────────────────────────
        app.MapPut("/api/admin/roles/{roleName}",
            async (string roleName, UpdateRoleRequest req, RoleService roles, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            var existing = await roles.GetRoleAsync(roleName)
                           ?? new RoleModel { Name = roleName };

            if (req.MaxNotesAllowed.HasValue)       existing.MaxNotesAllowed       = req.MaxNotesAllowed.Value;
            if (req.AllowFileUploads.HasValue)       existing.AllowFileUploads      = req.AllowFileUploads.Value;
            if (req.AttachmentSizeLimitMB.HasValue)  existing.AttachmentSizeLimitMB = req.AttachmentSizeLimitMB.Value;

            await roles.SaveRoleAsync(existing);
            return Results.Ok(existing);
        })
        .RequireAuthorization()
        .WithName("AdminUpdateRole")
        .WithSummary("Update usage restrictions for a role")
        .WithTags("Admin");

        // ── GET /api/admin/roles ──────────────────────────────────────────────
        app.MapGet("/api/admin/roles", async (RoleService roles, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();
            return Results.Ok(await roles.ListRolesAsync());
        })
        .RequireAuthorization()
        .WithName("AdminListRoles")
        .WithSummary("List all role definitions")
        .WithTags("Admin");

        // ── POST /api/admin/users — create user with temp password ─────────────
        app.MapPost("/api/admin/users",
            async (AdminCreateUserRequest req, UserService users, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            if (string.IsNullOrWhiteSpace(req.Username) ||
                string.IsNullOrWhiteSpace(req.Password))
                return Results.BadRequest(new { error = "Username and password are required." });

            if (req.Password.Length < 8)
                return Results.BadRequest(new { error = "Password must be at least 8 characters." });

            var normalised = req.Username.Trim().ToLowerInvariant();

            if (!UserService.IsValidUsername(normalised))
                return Results.BadRequest(new { error = "Username may only contain letters, digits, hyphens, underscores, and dots (max 50 chars)." });

            if (await users.GetUserAsync(normalised) is not null)
                return Results.Conflict(new { error = $"User '{normalised}' already exists." });

            var role = AllowedRoles.Contains((req.Role ?? string.Empty).Trim().ToLowerInvariant())
                ? req.Role!.Trim().ToLowerInvariant()
                : "member";

            var user = new UserModel
            {
                Username          = normalised,
                Name              = req.Name?.Trim() is { Length: > 0 } n ? n : normalised,
                Email             = req.Email?.Trim() ?? string.Empty,
                PasswordHash      = users.HashPassword(req.Password),
                Role              = role,
                MustResetPassword = true,  // Admin-created accounts always require a reset
            };

            await users.SaveUserAsync(user);
            return Results.Created($"/api/admin/users/{normalised}", Sanitize(user));
        })
        .RequireAuthorization()
        .WithName("AdminCreateUser")
        .WithSummary("Create a user with a temporary password (MustResetPassword = true)")
        .WithTags("Admin");

        // ── GET /api/admin/settings ───────────────────────────────────────────
        app.MapGet("/api/admin/settings",
            async (GlobalSettingsService globalSettings, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();
            var s = await globalSettings.GetAsync();
            return Results.Ok(RedactSettings(s));
        })
        .RequireAuthorization()
        .WithName("AdminGetSettings")
        .WithSummary("Get global instance settings (SMTP password redacted)")
        .WithTags("Admin");

        // ── POST /api/admin/settings/toggle-registration ──────────────────────
        app.MapPost("/api/admin/settings/toggle-registration",
            async (GlobalSettingsService globalSettings, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();
            var updated = await globalSettings.UpdateAsync(s =>
                s.AllowSelfRegistration = !s.AllowSelfRegistration);
            return Results.Ok(RedactSettings(updated));
        })
        .RequireAuthorization()
        .WithName("AdminToggleRegistration")
        .WithSummary("Toggle the AllowSelfRegistration global flag")
        .WithTags("Admin");

        // ── POST /api/admin/settings/toggle-email-verification ────────────────
        app.MapPost("/api/admin/settings/toggle-email-verification",
            async (GlobalSettingsService globalSettings, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();
            var updated = await globalSettings.UpdateAsync(s =>
                s.RequireEmailVerification = !s.RequireEmailVerification);
            return Results.Ok(RedactSettings(updated));
        })
        .RequireAuthorization()
        .WithName("AdminToggleEmailVerification")
        .WithSummary("Toggle the RequireEmailVerification global flag")
        .WithTags("Admin");

        // ── PUT /api/admin/settings/smtp ──────────────────────────────────────
        app.MapPut("/api/admin/settings/smtp",
            async (SmtpSettingsRequest req, GlobalSettingsService globalSettings,
                   EncryptionService encryption, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            if (string.IsNullOrWhiteSpace(req.Host))
                return Results.BadRequest(new { error = "Host is required." });

            if (string.IsNullOrWhiteSpace(req.FromAddress))
                return Results.BadRequest(new { error = "From address is required." });

            var updated = await globalSettings.UpdateAsync(s =>
            {
                s.Smtp ??= new SmtpSettings();
                s.Smtp.Host        = req.Host.Trim();
                s.Smtp.Port        = req.Port is > 0 ? req.Port : 587;
                s.Smtp.Security    = req.Security?.ToLowerInvariant() is "ssl" or "none" ? req.Security.ToLowerInvariant() : "starttls";
                s.Smtp.Username    = req.Username?.Trim() ?? string.Empty;
                s.Smtp.FromAddress = req.FromAddress.Trim();
                s.Smtp.FromName    = req.FromName?.Trim() is { Length: > 0 } n ? n : "Papyra";

                // Only update the password when a new one is provided
                if (!string.IsNullOrEmpty(req.Password))
                {
                    s.Smtp.PasswordEnc = encryption.HasKey
                        ? encryption.Encrypt(req.Password)
                        : null; // no encryption key — store nothing (caller warned via hasPassword)
                }
            });

            return Results.Ok(RedactSettings(updated));
        })
        .RequireAuthorization()
        .WithName("AdminSaveSmtp")
        .WithSummary("Save SMTP configuration (password stored encrypted)")
        .WithTags("Admin");

        // ── GET /api/admin/backup ─────────────────────────────────────────────
        // Streams a ZIP of all notes + .system config. Excludes the Lucene index
        // (disposable cache rebuilt on boot). Admin-only.
        app.MapGet("/api/admin/backup", (IConfiguration config, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            var storageRoot = config["Storage:StorageRoot"]
                ?? Path.Combine(AppContext.BaseDirectory, "data");

            if (!Directory.Exists(storageRoot))
                return Results.Problem("Storage directory not found.", statusCode: 500);

            var indexDir  = Path.Combine(storageRoot, "index");
            var timestamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");

            return Results.Stream(
                async stream =>
                {
                    // Buffer the ZIP in a MemoryStream first.
                    // ZipArchive.Dispose() writes the end-of-central-directory record
                    // synchronously; buffering avoids a sync-write to the response stream.
                    using var ms = new MemoryStream();

                    {
                        using var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true);

                        foreach (var file in Directory.EnumerateFiles(
                                     storageRoot, "*", SearchOption.AllDirectories))
                        {
                            // Skip the disposable Lucene index
                            if (file.StartsWith(indexDir + Path.DirectorySeparatorChar,
                                    StringComparison.OrdinalIgnoreCase))
                                continue;

                            var entryName = Path.GetRelativePath(storageRoot, file)
                                .Replace('\\', '/');
                            var entry = archive.CreateEntry(entryName, CompressionLevel.Fastest);
                            await using var entryStream = entry.Open();
                            await using var fileStream  = new FileStream(
                                file, FileMode.Open, FileAccess.Read, FileShare.Read);
                            await fileStream.CopyToAsync(entryStream);
                        }
                    } // ZipArchive finalizes here (synchronous write to MemoryStream — OK)

                    ms.Position = 0;
                    await ms.CopyToAsync(stream);
                },
                contentType: "application/zip",
                fileDownloadName: $"papyra-backup-{timestamp}.zip"
            );
        })
        .RequireAuthorization()
        .WithName("AdminBackup")
        .WithSummary("Stream a ZIP backup of all notes and system config (excludes Lucene index)")
        .WithTags("Admin");

        // ── POST /api/admin/settings/smtp/test ───────────────────────────────
        app.MapPost("/api/admin/settings/smtp/test",
            async (SmtpTestRequest req, EmailService email, HttpContext ctx) =>
        {
            if (!IsAdmin(ctx)) return Results.Forbid();

            var toAddress = string.IsNullOrWhiteSpace(req.ToAddress)
                ? ctx.User.FindFirst("email")?.Value ?? string.Empty
                : req.ToAddress.Trim();

            if (string.IsNullOrWhiteSpace(toAddress))
                return Results.BadRequest(new { error = "Provide a destination email address." });

            var cfg = await email.GetSmtpSettingsAsync();
            if (!email.IsConfigured(cfg))
                return Results.BadRequest(new { error = "SMTP is not configured yet." });

            // Probe first — fail fast before sending
            var probeError = await email.TestConnectionAsync();
            if (probeError is not null)
                return Results.Ok(new { success = false, error = probeError });

            try
            {
                await email.SendAsync(toAddress, "Papyra — SMTP test",
                    "<p>This is a test email from your Papyra instance. SMTP is configured correctly.</p>");
                return Results.Ok(new { success = true });
            }
            catch (Exception ex)
            {
                return Results.Ok(new { success = false, error = ex.Message });
            }
        })
        .RequireAuthorization()
        .WithName("AdminTestSmtp")
        .WithSummary("Send a test email to verify SMTP configuration")
        .WithTags("Admin");
    }

    internal static bool IsAdmin(HttpContext ctx)
    {
        var role = ctx.User.FindFirst(ClaimTypes.Role)?.Value;
        return string.Equals(role, AdminRole, StringComparison.OrdinalIgnoreCase);
    }

    // Roles that can be assigned via admin endpoints
    internal static readonly HashSet<string> AllowedRoles =
        new(StringComparer.OrdinalIgnoreCase) { AdminRole, MemberRole, ViewerRole };

    private static object Sanitize(UserModel u) => new
    {
        u.Username,
        u.Name,
        u.Email,
        u.Role,
        u.CreatedAt,
        u.TwoFactorEnabled,
        u.MustResetPassword,
    };

    // Returns settings safe to send to the client — SMTP password replaced with hasPassword flag.
    internal static object RedactSettings(GlobalSettingsModel s) => new
    {
        s.AllowSelfRegistration,
        s.RequireEmailVerification,
        smtp = s.Smtp is null ? null : new
        {
            s.Smtp.Host,
            s.Smtp.Port,
            s.Smtp.Security,
            s.Smtp.Username,
            s.Smtp.FromAddress,
            s.Smtp.FromName,
            hasPassword = !string.IsNullOrEmpty(s.Smtp.PasswordEnc),
        },
    };
}

record ChangeRoleRequest(string? Role);
record UpdateRoleRequest(int? MaxNotesAllowed, bool? AllowFileUploads, int? AttachmentSizeLimitMB);
record AdminCreateUserRequest(string Username, string Password, string? Name, string? Email, string? Role);
record SmtpSettingsRequest(string Host, int Port, string? Security, string? Username, string? Password, string FromAddress, string? FromName);
record SmtpTestRequest(string? ToAddress);
