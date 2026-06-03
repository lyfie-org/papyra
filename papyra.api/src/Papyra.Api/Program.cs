using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;
using Papyra.Api.Endpoints;
using Papyra.Api.Hubs;
using Papyra.Api.Middleware;
using Papyra.Api.Models;
using Papyra.Api.Services;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

var repoRoot    = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", ".."));
var storageRoot = builder.Configuration["Storage:StorageRoot"] is { Length: > 0 } s
    ? s
    : Path.Combine(repoRoot, "data");

builder.Configuration["Storage:StorageRoot"] = storageRoot;

var uploadsDir = Path.Combine(storageRoot, "_uploads");
Directory.CreateDirectory(storageRoot);
Directory.CreateDirectory(uploadsDir);
Directory.CreateDirectory(Path.Combine(storageRoot, ".system"));

builder.Services.Configure<KestrelServerOptions>(o =>
    o.Limits.MaxRequestBodySize = 16 * 1024 * 1024);

builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(30));

// Force Secure cookies in production; accept HTTP in development (behind a TLS-terminating
// reverse proxy, ForwardedHeaders middleware updates RemoteIpAddress before auth runs).
var cookieSecurePolicy = builder.Environment.IsProduction()
    ? CookieSecurePolicy.Always
    : CookieSecurePolicy.SameAsRequest;

// ── Cookie Authentication ──────────────────────────────────────────────────
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name         = "papyra.session";
        options.Cookie.HttpOnly     = true;
        options.Cookie.SecurePolicy = cookieSecurePolicy;
        options.Cookie.SameSite     = SameSiteMode.Lax;
        options.ExpireTimeSpan      = TimeSpan.FromDays(30);
        options.SlidingExpiration   = true;
        options.Events.OnRedirectToLogin = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

builder.Services.AddAuthorization();
builder.Services.AddOpenApi();

var scalarLogoPath = Path.Combine(repoRoot, "assets", "favicon", "android-chrome-192x192.png");
var scalarLogoDataUrl = File.Exists(scalarLogoPath)
    ? $"data:image/png;base64,{Convert.ToBase64String(File.ReadAllBytes(scalarLogoPath))}"
    : string.Empty;

builder.Services.AddSignalR(o =>
{
    o.KeepAliveInterval     = TimeSpan.FromSeconds(15);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
});

var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>()
    ?? ["http://localhost:5173"];

builder.Services.AddCors(options => options.AddPolicy("AllowedOrigins", policy =>
    policy.WithOrigins(allowedOrigins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials()));

builder.Services.AddSingleton<IMarkdownStorageService, MarkdownStorageService>();
builder.Services.AddSingleton<UserService>();
builder.Services.AddSingleton<RoleService>();
builder.Services.AddSingleton<TotpService>();
builder.Services.AddSingleton<UserSettingsService>();
builder.Services.AddSingleton<GlobalSettingsService>();
builder.Services.AddSingleton<PendingMfaStore>();
builder.Services.AddSingleton<EncryptionService>();
builder.Services.AddSingleton<EmailService>();
builder.Services.AddSingleton<AuditService>();
builder.Services.AddSingleton<AuthRateLimiter>();
builder.Services.AddSingleton<IdempotencyService>();

builder.Services.AddSingleton<IndexManager>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<IndexManager>());

builder.Services.AddSingleton<FuzzyIndexService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<FuzzyIndexService>());

builder.Services.AddSingleton<ShareService>();

builder.Services.AddSingleton<NoteWatcherService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<NoteWatcherService>());

// SignalR requires a UserIdentifier per connection for targeted messaging.
builder.Services.AddSingleton<IUserIdProvider, NameClaimUserIdProvider>();

var app = builder.Build();

// Seed default role definitions (admin + member) before any requests.
await app.Services.GetRequiredService<RoleService>().EnsureDefaultsAsync();

// In production, honour X-Forwarded-For / X-Forwarded-Proto from the reverse proxy.
// This ensures RemoteIpAddress reflects the real client IP before auth/rate-limiting run.
if (app.Environment.IsProduction())
{
    app.UseForwardedHeaders(new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    });
}

app.UseCors("AllowedOrigins");
app.UseAuthentication();
app.UseAuthorization();
app.UseMiddleware<PapyraSetupGuardMiddleware>();

app.UseDefaultFiles();
app.UseStaticFiles();

static void SetMediaHeaders(Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext ctx)
{
    var headers = ctx.Context.Response.Headers;
    headers.Append("X-Content-Type-Options", "nosniff");
    headers.Append("Cache-Control", "public, max-age=31536000, immutable");
    if (ctx.File.Name.EndsWith(".svg", StringComparison.OrdinalIgnoreCase))
        headers.Append("Content-Disposition", "attachment");
}

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider      = new PhysicalFileProvider(uploadsDir),
    RequestPath       = "/media",
    OnPrepareResponse = SetMediaHeaders,
});

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider      = new SecureStorageFileProvider(storageRoot),
    RequestPath       = "/storage",
    OnPrepareResponse = SetMediaHeaders,
});

app.MapOpenApi();

app.MapScalarApiReference(options =>
    {
        options.WithTitle("Papyra API")
               .WithClassicLayout()
               .HideSearch()
               .HideDeveloperTools()
               .WithDocumentDownloadType(DocumentDownloadType.None)
               .DisableAgent()
               .WithCustomCss(".scalar-app .references-header { display: none !important; }");
        if (!string.IsNullOrEmpty(scalarLogoDataUrl))
            options.WithFavicon(scalarLogoDataUrl);
    });

app.MapHub<NotesHub>("/hubs/notes");

// ── Endpoints ─────────────────────────────────────────────────────────────
AuthEndpoints.Map(app);
TwoFactorEndpoints.Map(app);
AdminEndpoints.Map(app);
UserEndpoints.Map(app);

// ── Health ─────────────────────────────────────────────────────────────────
app.MapGet("/health", async (GlobalSettingsService globalSettings, HttpContext ctx) =>
{
    // noteCount and smtpConfigured are behind auth — unauthenticated probes only
    // get the liveness signal to avoid leaking instance metadata to the public.
    if (ctx.User.Identity?.IsAuthenticated == true)
    {
        var cfg = await globalSettings.GetAsync();
        return Results.Ok(new
        {
            status         = "Healthy",
            app            = "Papyra API",
            smtpConfigured = cfg.Smtp is { Host.Length: > 0 },
        });
    }

    return Results.Ok(new { status = "Healthy", app = "Papyra API" });
})
    .ExcludeFromDescription();

// ── Notes ──────────────────────────────────────────────────────────────────

// GET /notes — active notes only (not archived, not deleted)
app.MapGet("/notes", (NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var username = ctx.User.Identity?.Name ?? string.Empty;
    var visible  = watcher.Notes.Values.Where(n =>
        !n.Archived && !n.Deleted &&
        IsPermitted(n, username, shares));

    return Results.Ok(visible.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color, n.Owner, n.CreatedAt, n.UpdatedAt,
    }));
})
    .RequireAuthorization()
    .WithName("GetNotes")
    .WithSummary("List active notes visible to the current user (metadata only)");

// GET /notes/shared — notes shared with the caller via ShareService
app.MapGet("/notes/shared", (NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var username    = ctx.User.Identity?.Name ?? string.Empty;
    var sharedNoteIds = shares.GetSharesForGrantee(username)
        .Select(r => r.NoteId)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    var shared = watcher.Notes.Values.Where(n =>
        !n.Deleted && sharedNoteIds.Contains(n.Id));

    return Results.Ok(shared.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color, n.Owner, n.Archived, n.CreatedAt, n.UpdatedAt,
    }));
})
    .RequireAuthorization()
    .WithName("GetSharedNotes")
    .WithSummary("Notes shared with the current user via ShareService");

// GET /notes/archived
app.MapGet("/notes/archived", (NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var username = ctx.User.Identity?.Name ?? string.Empty;
    var archived = watcher.Notes.Values.Where(n =>
        n.Archived && !n.Deleted && IsPermitted(n, username, shares));

    return Results.Ok(archived.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color, n.Owner, n.CreatedAt, n.UpdatedAt,
    }));
})
    .RequireAuthorization()
    .WithName("GetArchivedNotes")
    .WithSummary("Archived notes visible to the current user");

// GET /notes/trash
app.MapGet("/notes/trash", (NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var username = ctx.User.Identity?.Name ?? string.Empty;
    var deleted  = watcher.Notes.Values.Where(n =>
        n.Deleted && IsPermitted(n, username, shares));

    return Results.Ok(deleted.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color, n.Owner, n.CreatedAt, n.UpdatedAt,
    }));
})
    .RequireAuthorization()
    .WithName("GetTrashedNotes")
    .WithSummary("Deleted (soft) notes visible to the current user");

// GET /notes/{id}
app.MapGet("/notes/{id}", (string id, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var meta = watcher.Notes.Values.FirstOrDefault(n => n.Id == id);
    if (meta is null) return Results.NotFound();

    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();

    // Lazy body read: only this endpoint touches disk for note content.
    var note = watcher.ReadFullNote(id);
    return note is null ? Results.NotFound() : Results.Ok(note);
})
    .RequireAuthorization()
    .WithName("GetNote")
    .WithSummary("Get a single note by ID including Content");

// POST /notes — create a note, enforcing MaxNotesAllowed from the user's role
app.MapPost("/notes", async (CreateNoteRequest req, IMarkdownStorageService storage,
    NoteWatcherService watcher, UserService users, RoleService roles, HttpContext ctx) =>
{
    var username = ctx.User.Identity?.Name ?? string.Empty;
    var user     = await users.GetUserAsync(username);
    var roleName = user?.Role ?? "member";
    var role     = await roles.GetRoleAsync(roleName) ?? new RoleModel { Name = roleName };

    if (role.MaxNotesAllowed >= 0)
    {
        var activeCount = watcher.Notes.Values.Count(n =>
            n.Owner.Equals(username, StringComparison.OrdinalIgnoreCase) &&
            !n.Archived && !n.Deleted);

        if (activeCount >= role.MaxNotesAllowed)
            return Results.Json(
                new { error = $"Note limit of {role.MaxNotesAllowed} reached for role '{roleName}'." },
                statusCode: StatusCodes.Status403Forbidden);
    }

    var id  = Guid.NewGuid().ToString();
    var now = DateTime.UtcNow;
    var note = new Note
    {
        Id        = id,
        Title     = req.Title,
        Tags      = req.Tags ?? [],
        Color     = req.Color ?? string.Empty,
        Owner     = username,
        CreatedAt = now,
        UpdatedAt = now,
    };
    var noteDir = Path.Combine(storageRoot, id);
    Directory.CreateDirectory(noteDir);
    var notePath = Path.Combine(noteDir, "note.md");
    await watcher.SafeWriteNoteAsync(notePath, storage.SerializeNote(note));
    return Results.Created($"/notes/{id}", new { id });
})
    .RequireAuthorization()
    .WithName("CreateNote")
    .WithSummary("Create a new note (enforces MaxNotesAllowed for the user's role)");

// PUT /notes/{id}
app.MapPut("/notes/{id}", async (string id, UpdateNoteRequest req,
    NoteWatcherService watcher, IMarkdownStorageService storage,
    ShareService shares, IdempotencyService idempotency, HttpContext ctx) =>
{
    // Idempotent replay: an offline client resending a queued mutation with the
    // same key should not re-apply the write if we already processed it.
    var idemKey = ctx.Request.Headers["X-Idempotency-Key"].FirstOrDefault();
    if (idemKey is not null && idempotency.HasSeen(idemKey))
        return Results.NoContent();

    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    // Read full note from disk to preserve current content.
    var note = watcher.ReadFullNote(id);
    if (note is null) return Results.NotFound();

    if (req.Title   is not null) note.Title   = req.Title;
    if (req.Tags    is not null) note.Tags    = req.Tags;
    if (req.Pinned.HasValue)     note.Pinned  = req.Pinned.Value;
    if (req.Color   is not null) note.Color   = req.Color;
    if (req.Content is not null) note.Content = req.Content;
    note.UpdatedAt = DateTime.UtcNow;

    await watcher.SafeWriteNoteAsync(path, storage.SerializeNote(note));
    watcher.Notes[path] = meta with
    {
        Title     = note.Title,
        Tags      = note.Tags,
        Pinned    = note.Pinned,
        Color     = note.Color,
        UpdatedAt = note.UpdatedAt,
    };

    if (idemKey is not null) idempotency.Record(idemKey);
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("UpdateNote")
    .WithSummary("Partially update a note (owner or shared collaborators)");

// DELETE /notes/{id} — hard delete; owner or write-permitted users
app.MapDelete("/notes/{id}", async (string id, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    var noteDir = Path.GetDirectoryName(path);
    if (noteDir is not null && Directory.Exists(noteDir))
        await Task.Run(() => Directory.Delete(noteDir, recursive: true));
    else
        File.Delete(path);

    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("DeleteNote")
    .WithSummary("Permanently delete a note and its media");

// PATCH /api/notes/{id}/archive
app.MapPatch("/api/notes/{id}/archive",
    async (string id, NoteWatcherService watcher, IMarkdownStorageService storage, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    var note = watcher.ReadFullNote(id);
    if (note is null) return Results.NotFound();
    note.Archived  = true;
    note.Deleted   = false;
    note.UpdatedAt = DateTime.UtcNow;
    await watcher.SafeWriteNoteAsync(path, storage.SerializeNote(note));
    // Optimistic cache update — FSW re-validates after debounce to same state.
    watcher.Notes[path] = meta with { Archived = true, Deleted = false, UpdatedAt = note.UpdatedAt };
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("ArchiveNote")
    .WithSummary("Move a note to the archive");

// PATCH /api/notes/{id}/restore — un-archive
app.MapPatch("/api/notes/{id}/restore",
    async (string id, NoteWatcherService watcher, IMarkdownStorageService storage, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    var note = watcher.ReadFullNote(id);
    if (note is null) return Results.NotFound();
    note.Archived  = false;
    note.UpdatedAt = DateTime.UtcNow;
    await watcher.SafeWriteNoteAsync(path, storage.SerializeNote(note));
    watcher.Notes[path] = meta with { Archived = false, UpdatedAt = note.UpdatedAt };
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("RestoreNote")
    .WithSummary("Restore an archived note");

// PATCH /api/notes/{id}/trash — soft delete
app.MapPatch("/api/notes/{id}/trash",
    async (string id, NoteWatcherService watcher, IMarkdownStorageService storage, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    var note = watcher.ReadFullNote(id);
    if (note is null) return Results.NotFound();
    note.Deleted   = true;
    note.Archived  = false;
    note.UpdatedAt = DateTime.UtcNow;
    await watcher.SafeWriteNoteAsync(path, storage.SerializeNote(note));
    watcher.Notes[path] = meta with { Deleted = true, Archived = false, UpdatedAt = note.UpdatedAt };
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("TrashNote")
    .WithSummary("Soft-delete a note (moves to trash)");

// PATCH /api/notes/{id}/restore-trash
app.MapPatch("/api/notes/{id}/restore-trash",
    async (string id, NoteWatcherService watcher, IMarkdownStorageService storage, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var (path, meta) = found.Value;

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var role     = ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "member";
    if (!IsPermitted(meta, username, shares)) return Results.Forbid();
    if (IsWriteBlocked(meta, username, role, shares)) return Results.Forbid();

    var note = watcher.ReadFullNote(id);
    if (note is null) return Results.NotFound();
    note.Deleted   = false;
    note.UpdatedAt = DateTime.UtcNow;
    await watcher.SafeWriteNoteAsync(path, storage.SerializeNote(note));
    watcher.Notes[path] = meta with { Deleted = false, UpdatedAt = note.UpdatedAt };
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("RestoreFromTrash")
    .WithSummary("Restore a soft-deleted note from trash");

// ── Sharing endpoints ────────────────────────────────────────────────────────

// GET /api/notes/{id}/shares — list all shares for a note (owner only)
app.MapGet("/api/notes/{id}/shares",
    (string id, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!found.Value.Meta.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)) return Results.Forbid();
    return Results.Ok(shares.GetSharesForNote(id));
})
    .RequireAuthorization()
    .WithName("GetShares")
    .WithSummary("List shares for a note (owner only)");

// POST /api/notes/{id}/shares — add a user share (owner only)
app.MapPost("/api/notes/{id}/shares",
    async (string id, CreateShareRequest req, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var note     = found.Value.Meta;
    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!note.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)) return Results.Forbid();
    if (string.IsNullOrWhiteSpace(req.Grantee))
        return Results.BadRequest(new { error = "Grantee username is required." });

    var record = new ShareRecord
    {
        ShareId    = Guid.NewGuid().ToString(),
        NoteId     = id,
        OwnerId    = username,
        Grantee    = req.Grantee.Trim().ToLowerInvariant(),
        Permission = req.Permission is "write" ? "write" : "read",
        ExpiresAt  = req.ExpiresAt,
    };
    await shares.CreateAsync(record);
    return Results.Created($"/api/notes/{id}/shares/{record.ShareId}", record);
})
    .RequireAuthorization()
    .WithName("CreateShare")
    .WithSummary("Share a note with a user (owner only)");

// DELETE /api/notes/{id}/shares/{shareId} — revoke a share (owner only)
app.MapDelete("/api/notes/{id}/shares/{shareId}",
    async (string id, string shareId, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!found.Value.Meta.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)) return Results.Forbid();
    await shares.DeleteAsync(shareId);
    return Results.NoContent();
})
    .RequireAuthorization()
    .WithName("DeleteShare")
    .WithSummary("Revoke a share (owner only)");

// POST /api/notes/{id}/shares/public — create a signed public link (owner only, always read-only)
app.MapPost("/api/notes/{id}/shares/public",
    async (string id, PublicLinkRequest req, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var found = watcher.FindNote(id);
    if (found is null) return Results.NotFound();
    var note     = found.Value.Meta;
    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!note.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)) return Results.Forbid();

    var days   = Math.Clamp(req.ExpiresInDays, 1, 365);
    var expiry = DateTime.UtcNow.AddDays(days);
    var shareId = Guid.NewGuid().ToString();
    var token   = shares.GeneratePublicToken(shareId, expiry);

    var record = new ShareRecord
    {
        ShareId     = shareId,
        NoteId      = id,
        OwnerId     = username,
        Grantee     = null,
        Permission  = "read",
        ExpiresAt   = expiry,
        PublicToken = token,
    };
    await shares.CreateAsync(record);
    return Results.Ok(new { token, expiry, shareId });
})
    .RequireAuthorization()
    .WithName("CreatePublicLink")
    .WithSummary("Create a signed public read-only link for a note (owner only)");

// GET /api/share/{token} — read a note via public link (no auth required)
app.MapGet("/api/share/{token}",
    (string token, ShareService shares, NoteWatcherService watcher) =>
{
    var record = shares.ValidatePublicToken(token);
    if (record is null) return Results.NotFound();

    var found2 = watcher.FindNote(record.NoteId);
    if (found2 is null || found2.Value.Meta.Deleted) return Results.NotFound();
    var meta = found2.Value.Meta;

    // Public link requires content — lazy body read from disk.
    var note = watcher.ReadFullNote(record.NoteId);
    if (note is null) return Results.NotFound();

    return Results.Ok(new
    {
        note.Id, note.Title, note.Tags, note.Color,
        note.Content, note.CreatedAt, note.UpdatedAt,
    });
})
    .WithName("GetPublicNote")
    .WithSummary("Access a note via a signed public link (no authentication required)");

// POST /api/notes/{id}/media
app.MapPost("/api/notes/{id}/media",
    async (string id, IFormFile file, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    var note = watcher.Notes.Values.FirstOrDefault(n => n.Id == id);
    if (note is null) return Results.NotFound();

    var username = ctx.User.Identity?.Name ?? string.Empty;
    if (!IsPermitted(note, username, shares)) return Results.Forbid();

    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg" };

    var ext = Path.GetExtension(file.FileName);
    if (!allowedExtensions.Contains(ext))
        return Results.BadRequest(new { error = $"File type '{ext}' is not allowed." });

    var mediaDir = Path.Combine(storageRoot, id, "media");
    Directory.CreateDirectory(mediaDir);

    var fileName = $"{Guid.NewGuid()}{ext}";
    await using var stream = File.Create(Path.Combine(mediaDir, fileName));
    await file.CopyToAsync(stream);

    return Results.Ok(new { url = $"/storage/{id}/media/{fileName}" });
})
    .RequireAuthorization()
    .WithName("UploadNoteMedia")
    .WithSummary("Upload an image for a specific note; returns its public /storage URL")
    .DisableAntiforgery();

// POST /api/upload/image — legacy global upload
app.MapPost("/api/upload/image", async (IFormFile file) =>
{
    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg" };

    var ext = Path.GetExtension(file.FileName);
    if (!allowedExtensions.Contains(ext))
        return Results.BadRequest(new { error = $"File type '{ext}' is not allowed." });

    var fileName = $"{Guid.NewGuid()}{ext}";
    await using var stream = File.Create(Path.Combine(uploadsDir, fileName));
    await file.CopyToAsync(stream);

    return Results.Ok(new { url = $"/media/{fileName}" });
})
    .RequireAuthorization()
    .WithName("UploadImage")
    .WithSummary("Upload an image (legacy); returns its public /media URL")
    .DisableAntiforgery();

// GET /search — full-text via Lucene
app.MapGet("/search", (string q, IndexManager indexManager, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var username = ctx.User.Identity?.Name ?? string.Empty;
    var hits     = indexManager.Search(q);
    var response = hits
        .Select(hit =>
        {
            var hitFound = watcher.FindNote(hit.Id);
            if (hitFound is null) return null;
            var meta = hitFound.Value.Meta;
            if (meta.Deleted || !IsPermitted(meta, username, shares)) return null;
            return new { meta.Id, meta.Title, meta.Tags, meta.Pinned, meta.Color, hit.Snippet };
        })
        .Where(r => r is not null);

    return Results.Ok(response);
})
    .RequireAuthorization()
    .WithName("SearchNotes")
    .WithSummary("Full-text search via Lucene (respects ownership; excludes trash)");

// GET /api/search/fuzzy — instant omni-bar via in-memory trigram index, zero disk I/O
app.MapGet("/api/search/fuzzy", (string q, int limit, FuzzyIndexService fuzzy, NoteWatcherService watcher, ShareService shares, HttpContext ctx) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var username     = ctx.User.Identity?.Name ?? string.Empty;
    var clampedLimit = Math.Clamp(limit <= 0 ? 10 : limit, 1, 50);
    var noteIds      = fuzzy.Query(q, clampedLimit * 2);  // over-fetch to allow permission filtering

    var results = noteIds
        .Select(nid => watcher.FindNote(nid)?.Meta)
        .Where(meta => meta is not null && !meta!.Deleted && IsPermitted(meta, username, shares))
        .Take(clampedLimit)
        .Select(meta => new { meta!.Id, meta.Title, meta.Tags, meta.Color, meta.UpdatedAt });

    return Results.Ok(results);
})
    .RequireAuthorization()
    .WithName("FuzzySearchNotes")
    .WithSummary("Instant omni-bar fuzzy search via in-memory trigram index (zero disk I/O)");

app.MapFallbackToFile("index.html");

app.Run();

// ── Ownership / permission helpers ───────────────────────────────────────────
// Absolute Privacy Wall: owner or an active share grant. Pre-auth legacy notes (Owner=="") are public.
static bool IsPermitted(NoteMetadata meta, string username, ShareService shares)
{
    if (string.IsNullOrEmpty(meta.Owner)) return true;
    return meta.Owner.Equals(username, StringComparison.OrdinalIgnoreCase) ||
           shares.IsGranted(meta.Id, username);
}

// Blocks writes for: viewer role (not owner), or non-owner with read-only share.
static bool IsWriteBlocked(NoteMetadata meta, string username, string role, ShareService shares)
{
    if (string.IsNullOrEmpty(meta.Owner)) return false;
    if (meta.Owner.Equals(username, StringComparison.OrdinalIgnoreCase)) return false;
    if (role.Equals(RoleService.ViewerRole, StringComparison.OrdinalIgnoreCase)) return true;
    return shares.IsGranted(meta.Id, username) && !shares.IsWriteGranted(meta.Id, username);
}

// ── Request / response records ────────────────────────────────────────────────

record CreateNoteRequest(string Title, List<string>? Tags, string? Color);
record UpdateNoteRequest(string? Title, List<string>? Tags, bool? Pinned, string? Color, string? Content);
record CreateShareRequest(string? Grantee, string? Permission, DateTime? ExpiresAt);
record PublicLinkRequest(int ExpiresInDays);

// ── SignalR UserIdentifier provider ──────────────────────────────────────────
// Maps connections to the ClaimTypes.Name claim so we can target by username.
sealed class NameClaimUserIdProvider : Microsoft.AspNetCore.SignalR.IUserIdProvider
{
    public string? GetUserId(Microsoft.AspNetCore.SignalR.HubConnectionContext connection) =>
        connection.User?.FindFirst(ClaimTypes.Name)?.Value;
}

// Makes the implicit top-level Program class visible to WebApplicationFactory in integration tests.
public partial class Program { }

// ── SecureStorageFileProvider ─────────────────────────────────────────────────
// Wraps PhysicalFileProvider and blocks any request for paths inside .system/.
// Prevents unauthenticated access to password hashes, TOTP secrets, audit logs,
// SMTP credentials, and share records that live under storageRoot/.system/.
// Static files middleware bypasses the authorization pipeline, so we enforce the
// boundary here at the provider level.
sealed class SecureStorageFileProvider(string storageRoot) : IFileProvider
{
    private readonly PhysicalFileProvider _inner = new(storageRoot);

    private static bool IsSensitive(string subpath) =>
        subpath.Contains(".system", StringComparison.OrdinalIgnoreCase);

    public IFileInfo GetFileInfo(string subpath) =>
        IsSensitive(subpath) ? new NotFoundFileInfo(subpath) : _inner.GetFileInfo(subpath);

    public IDirectoryContents GetDirectoryContents(string subpath) =>
        IsSensitive(subpath) ? NotFoundDirectoryContents.Singleton : _inner.GetDirectoryContents(subpath);

    public IChangeToken Watch(string filter) => NullChangeToken.Singleton;
}
