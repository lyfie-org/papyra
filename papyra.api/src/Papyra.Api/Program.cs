using System.Security;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

// ── Relational cache (SQLite — disposable; filesystem is the authority) ──────
// Resolve the DB path at DI time (not builder time) so test/host config overrides
// of "Papyra:DataDir" are honored — same deferral the vault paths use below.
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    var dbPath = PapyraPaths.DbPath(
        sp.GetRequiredService<IConfiguration>(),
        sp.GetRequiredService<IHostEnvironment>().ContentRootPath);
    Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
    options.UseSqlite($"Data Source={dbPath}");
});

// Zero-trust markdown engine (filesystem is the authority; this is the only
// thing that serializes notes to/from .md).
builder.Services.AddSingleton<MarkdownStorageService>();

// ── Reactive observer: keep the in-memory vault in sync with the .md files ────
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<VaultState>();
builder.Services.AddSingleton<WriteRing>();
builder.Services.AddSingleton(sp => new VaultObserverOptions
{
    UsersDir = PapyraPaths.UsersDir(
        sp.GetRequiredService<IConfiguration>(),
        sp.GetRequiredService<IHostEnvironment>().ContentRootPath),
});

// ── Ephemeral full-text index (Lucene — disposable; rebuilt from the .md files) ─
builder.Services.AddSingleton<SearchIndexService>();

// Timestamped version history per note (throttled + age-pruned), for recovery.
builder.Services.AddSingleton<SnapshotService>();

// In-memory registry of sync-tool conflict copies awaiting resolution (disposable;
// rebuilt from disk by the cold-boot diff + watcher).
builder.Services.AddSingleton<ConflictState>();

// Reconcile disk vs the caches on boot (before ports open), then watch live, then
// sweep orphaned media nightly. Order matters: the cold-boot diff runs first.
// The observer is a singleton too so the setup/provision flow can call WatchUser
// when a new tenant's vault is created.
builder.Services.AddSingleton<VaultObserver>();
builder.Services.AddHostedService<ColdBootDiffService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<VaultObserver>());
builder.Services.AddHostedService<OrphanPruneService>();

// Background import queue: drains uploaded Obsidian/Keep archives into the vault
// off the request thread, pushing progress over SignalR. Singleton so the endpoint
// can Enqueue onto the same instance the hosted worker drains.
builder.Services.AddSingleton<ImportService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ImportService>());

// Real-time push: the observer broadcasts metadata-only note events to clients.
builder.Services.AddSignalR();

// ── Cookie auth ──────────────────────────────────────────────────────────────
// Sessions ride a single HttpOnly cookie. SameSite=Strict + (in prod) Secure;
// sliding expiry keeps active users signed in. The SPA is same-origin in prod,
// so we never need to surface this cookie to JS. Unauthenticated API calls get a
// flat 401 (no login redirect) so the client router can route to /login itself.
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "papyra.auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
            ? CookieSecurePolicy.SameAsRequest
            : CookieSecurePolicy.Always;
        options.SlidingExpiration = true;
        options.ExpireTimeSpan = TimeSpan.FromDays(7);
        // API, not MVC: answer with status codes instead of 302 redirects.
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

var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>()
    ?? ["http://localhost:5173"];

builder.Services.AddCors(options => options.AddPolicy("AllowedOrigins", policy =>
    policy.WithOrigins(allowedOrigins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials()));

var app = builder.Build();

// Run migrations on boot so papyra.db materializes before ports open.
using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.Migrate();
}

app.UseCors("AllowedOrigins");

// ── Init gate ────────────────────────────────────────────────────────────────
// Until the first admin exists, every /api call (except the auth endpoints that
// create that admin) short-circuits to 428 Precondition Required so the SPA can
// route the user to the setup screen. Static files + Scalar stay reachable so the
// setup UI can load.
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    if (path.StartsWithSegments("/api") && !path.StartsWithSegments("/api/auth"))
    {
        var db = context.RequestServices.GetRequiredService<AppDbContext>();
        if (!await db.Users.AnyAsync(context.RequestAborted))
        {
            context.Response.StatusCode = StatusCodes.Status428PreconditionRequired;
            await context.Response.WriteAsJsonAsync(
                new { error = "Setup required.", code = "setup_required" },
                context.RequestAborted);
            return;
        }
    }

    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthentication();
app.UseAuthorization();

// ── Path-jail backstop ────────────────────────────────────────────────────────
// Any filename that escapes a tenant's vault throws SecurityException from
// PathGuard; translate it to a flat 403 (the breach is already logged at source).
app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (SecurityException)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(
            new { error = "Forbidden.", code = "path_jail" },
            context.RequestAborted);
    }
});

app.MapOpenApi();

app.MapScalarApiReference(options =>
    options.WithTitle("Papyra API")
           .WithClassicLayout()
           .HideSearch()
           .HideDeveloperTools()
           .WithDocumentDownloadType(DocumentDownloadType.None)
           .DisableAgent()
           .WithCustomCss(".scalar-app .references-header { display: none !important; }"));

// ── Health ─────────────────────────────────────────────────────────────────
app.MapGet("/health", () => Results.Ok(new { status = "Healthy", app = "Papyra API" }))
    .ExcludeFromDescription();

// ── Auth: first-admin setup ──────────────────────────────────────────────────
// One-shot bootstrap. Only succeeds while the user table is empty; the created
// account is always the admin. Login/logout + cookie sessions land in Sprint 6.2.
var auth = app.MapGroup("/api/auth");

auth.MapPost("/setup", async (SetupRequest body, HttpContext http, AppDbContext db, VaultObserver observer, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct))
        return Results.Conflict(new { error = "Already initialized." });

    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Username and password are required." });

    var user = new User
    {
        Username = body.Username.Trim(),
        Name = string.IsNullOrWhiteSpace(body.Name) ? body.Username.Trim() : body.Name.Trim(),
        Email = body.Email?.Trim() ?? string.Empty,
        PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password),
        Role = "Admin",
    };

    db.Users.Add(user);
    await db.SaveChangesAsync(ct);

    observer.WatchUser(user.Id.ToString()); // create + watch the new tenant's vault
    await SignInAsync(http, user); // the first admin starts signed in
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role });
});

// Validate credentials against the BCrypt hash and mint the session cookie. Same
// generic 401 for unknown user and bad password so we don't leak which one failed.
auth.MapPost("/login", async (LoginRequest body, HttpContext http, AppDbContext db, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Username and password are required." });

    var user = await db.Users.FirstOrDefaultAsync(u => u.Username == body.Username.Trim(), ct);
    if (user is null || !BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash))
        return Results.Json(new { error = "Invalid credentials." }, statusCode: StatusCodes.Status401Unauthorized);

    await SignInAsync(http, user);
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role });
});

auth.MapPost("/logout", async (HttpContext http) =>
{
    await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.NoContent();
});

// Current-session probe the SPA auth guard polls: 428 before any user exists
// (route to /setup), 401 when unauthenticated (route to /login), else the user.
auth.MapGet("/me", async (HttpContext http, AppDbContext db, CancellationToken ct) =>
{
    if (!await db.Users.AnyAsync(ct))
        return Results.Json(new { error = "Setup required.", code = "setup_required" },
            statusCode: StatusCodes.Status428PreconditionRequired);

    if (http.User.Identity?.IsAuthenticated != true)
        return Results.Json(new { error = "Not authenticated." },
            statusCode: StatusCodes.Status401Unauthorized);

    var id = int.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    var user = await db.Users.FindAsync([id], ct);
    if (user is null)
        return Results.Json(new { error = "Not authenticated." },
            statusCode: StatusCodes.Status401Unauthorized);

    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role });
});

// ── Admin user management ──────────────────────────────────────────────────────
// Role-gated provisioning for the settings Admin tab. Provisioned users get their
// tenant vault created + watched, same as the first-admin setup flow.
var admin = auth.MapGroup("/users").RequireAuthorization(p => p.RequireRole("Admin"));

admin.MapGet("/", async (AppDbContext db, CancellationToken ct) =>
    Results.Ok(await db.Users
        .OrderBy(u => u.Id)
        .Select(u => new { u.Id, u.Username, u.Name, u.Email, u.Role })
        .ToListAsync(ct)));

admin.MapPost("/", async (ProvisionRequest body, AppDbContext db, VaultObserver observer, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Username and password are required." });

    var username = body.Username.Trim();
    if (await db.Users.AnyAsync(u => u.Username == username, ct))
        return Results.Conflict(new { error = "Username already taken." });

    var user = new User
    {
        Username = username,
        Name = string.IsNullOrWhiteSpace(body.Name) ? username : body.Name.Trim(),
        Email = body.Email?.Trim() ?? string.Empty,
        PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password),
        Role = body.Role == "Admin" ? "Admin" : "User",
    };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);

    observer.WatchUser(user.Id.ToString()); // create + watch the new tenant's vault
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role });
});

admin.MapPost("/{id:int}/reset", async (int id, ResetRequest body, AppDbContext db, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Password is required." });

    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── Notes CRUD ───────────────────────────────────────────────────────────────
// Reads serve the in-memory vault (no disk hit); writes go through the atomic
// markdown engine, logging the path in the Write-Ring so the watcher ignores the
// echo. Filesystem stays the source of truth — VaultState is just a mirror.
var notes = app.MapGroup("/api/notes").RequireAuthorization();

notes.MapGet("/", (ClaimsPrincipal user, VaultState state) =>
    Results.Ok(state.Snapshot(Uid(user))));

notes.MapPut("/{id}", async (
    string id,
    NoteWrite body,
    ClaimsPrincipal user,
    VaultState state,
    MarkdownStorageService storage,
    WriteRing writeRing,
    SearchIndexService search,
    SnapshotService snapshots,
    VaultObserverOptions vault,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    // Resolve under the caller's vault and verify it can't escape (→ 403).
    var path = state.PathFor(uid, id)
        ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(uid), $"{id}.md", loggerFactory.CreateLogger("PathGuard"));

    var note = new Note
    {
        Id = id,
        Title = body.Title ?? string.Empty,
        Tags = body.Tags ?? [],
        Color = body.Color,
        Pinned = body.Pinned,
        Archived = body.Archived,
        Body = body.Body ?? string.Empty,
    };

    // Snapshot the prior on-disk revision before we overwrite it (throttled).
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, loggerFactory.CreateLogger("PathGuard"));
    await snapshots.CaptureAsync(noteSnapDir, path, ct);

    writeRing.Mark(path); // log self-write before touching disk (loop prevention)
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.IndexNote(uid, note); // watcher skips our own write echo, so index here

    return Results.Ok(note);
});

notes.MapDelete("/{id}", (
    string id,
    ClaimsPrincipal user,
    VaultState state,
    WriteRing writeRing,
    SearchIndexService search) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null) return Results.NotFound();

    writeRing.Mark(path); // watcher ignores the delete echo
    if (File.Exists(path)) File.Delete(path);
    state.Remove(uid, path);
    search.RemoveNote(id); // watcher skips the echo, so drop from the index here

    return Results.NoContent();
});

// ── Snapshots (version history & recovery) ──────────────────────────────────────
// Throttled, age-pruned timestamped copies under the user's hidden .papyra dir.
// List is metadata-only; the single-snapshot GET returns the archived body so the
// editor can render a diff; restore atomically replaces the live .md.
notes.MapGet("/{id}/snapshots", (
    string id,
    ClaimsPrincipal user,
    SnapshotService snapshots,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory) =>
{
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, Uid(user));
    var dir = PathGuard.ResolveAndVerify(snapRoot, id, loggerFactory.CreateLogger("PathGuard"));
    return Results.Ok(snapshots.List(dir).Select(s => new { id = s.Id, timestamp = s.TimestampUtc }));
});

notes.MapGet("/{id}/snapshots/{snapshotId}", async (
    string id,
    string snapshotId,
    ClaimsPrincipal user,
    MarkdownStorageService storage,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, Uid(user));
    var logger = loggerFactory.CreateLogger("PathGuard");
    var snapPath = PathGuard.ResolveAndVerify(snapRoot, Path.Combine(id, $"{snapshotId}.md"), logger);

    var note = await storage.ReadAsync(snapPath, ct);
    return note is null ? Results.NotFound() : Results.Ok(note);
});

notes.MapPost("/{id}/restore/{snapshotId}", async (
    string id,
    string snapshotId,
    ClaimsPrincipal user,
    VaultState state,
    MarkdownStorageService storage,
    SnapshotService snapshots,
    WriteRing writeRing,
    SearchIndexService search,
    VaultObserverOptions vault,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    var logger = loggerFactory.CreateLogger("PathGuard");
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var snapPath = PathGuard.ResolveAndVerify(snapRoot, Path.Combine(id, $"{snapshotId}.md"), logger);
    if (!File.Exists(snapPath)) return Results.NotFound();

    var path = state.PathFor(uid, id)
        ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(uid), $"{id}.md", logger);

    // Archive the current revision first so the restore itself is reversible, then
    // atomically swap the snapshot in. Log the self-write so the watcher ignores it.
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, logger);
    await snapshots.CaptureAsync(noteSnapDir, path, ct);

    writeRing.Mark(path);
    await snapshots.RestoreAsync(snapPath, path, ct);

    var note = await storage.ReadAsync(path, ct);
    if (note is null) return Results.NotFound();
    state.Upsert(uid, path, note);
    search.IndexNote(uid, note);
    return Results.Ok(note);
});

// ── Conflicts (sync-copy resolution) ────────────────────────────────────────────
// Sync tools (Syncthing/Dropbox/Nextcloud) drop a conflict copy next to a note
// when two devices edit it offline. The observer registers these instead of
// parsing them as notes. List is metadata-only; the detail GET returns both bodies
// for the split-pane resolver; resolve keeps left (parent), right (the copy), or
// both (the copy becomes a new note) and always deletes the rejected .md.
var conflicts = app.MapGroup("/api/conflicts").RequireAuthorization();

conflicts.MapGet("/", (ClaimsPrincipal user, ConflictState conflictState, VaultState state) =>
{
    var uid = Uid(user);
    return Results.Ok(conflictState.Snapshot(uid).Select(c =>
    {
        var parent = state.PathFor(uid, c.ParentId) is { } p && state.TryGet(uid, p, out var pn) ? pn : null;
        return new
        {
            id = c.Id,
            parentId = c.ParentId,
            parentTitle = parent?.Title ?? string.Empty,
            conflictTitle = c.ConflictTitle,
            detected = c.DetectedUtc,
        };
    }));
});

conflicts.MapGet("/{id}", async (
    string id,
    ClaimsPrincipal user,
    ConflictState conflictState,
    VaultState state,
    MarkdownStorageService storage,
    VaultObserverOptions vault,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    if (!conflictState.TryGet(uid, id, out var c) || c is null) return Results.NotFound();

    var notesDir = vault.UserNotesDir(uid);
    var logger = loggerFactory.CreateLogger("PathGuard");
    var conflictPath = PathGuard.ResolveAndVerify(notesDir, c.RelativePath, logger);
    var conflictNote = await storage.ReadAsync(conflictPath, ct);
    if (conflictNote is null) return Results.NotFound();

    var parentNote = state.PathFor(uid, c.ParentId) is { } p && state.TryGet(uid, p, out var pn)
        ? pn
        : await storage.ReadAsync(PathGuard.ResolveAndVerify(notesDir, c.ParentRelativePath, logger), ct);

    return Results.Ok(new
    {
        id = c.Id,
        parentId = c.ParentId,
        parentTitle = parentNote?.Title ?? string.Empty,
        parentBody = parentNote?.Body ?? string.Empty,
        conflictTitle = conflictNote.Title,
        conflictBody = conflictNote.Body,
    });
});

conflicts.MapPost("/{id}/resolve", async (
    string id,
    ResolveConflictRequest body,
    ClaimsPrincipal user,
    ConflictState conflictState,
    VaultState state,
    MarkdownStorageService storage,
    WriteRing writeRing,
    SearchIndexService search,
    VaultObserverOptions vault,
    IHubContext<NotesHub> hub,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    if (!conflictState.TryGet(uid, id, out var c) || c is null) return Results.NotFound();

    var keep = body.Keep?.Trim().ToLowerInvariant();
    if (keep is not ("left" or "right" or "both"))
        return Results.BadRequest(new { error = "keep must be left, right, or both." });

    var notesDir = vault.UserNotesDir(uid);
    var logger = loggerFactory.CreateLogger("PathGuard");
    var conflictPath = PathGuard.ResolveAndVerify(notesDir, c.RelativePath, logger);
    if (!File.Exists(conflictPath))
    {
        conflictState.Remove(uid, id, out _); // already gone — clear the stale entry
        return Results.NotFound();
    }

    // "right" overwrites the parent with the copy's content (parent id preserved);
    // "both" promotes the copy to a brand-new note. "left" keeps the parent as-is.
    if (keep is "right" or "both")
    {
        var copy = await storage.ReadAsync(conflictPath, ct);
        if (copy is not null)
        {
            var targetPath = keep == "right"
                ? state.PathFor(uid, c.ParentId) ?? PathGuard.ResolveAndVerify(notesDir, c.ParentRelativePath, logger)
                : PathGuard.ResolveAndVerify(notesDir, $"{Guid.NewGuid()}.md", logger);
            copy.Id = keep == "right" ? c.ParentId : Path.GetFileNameWithoutExtension(targetPath);

            writeRing.Mark(targetPath); // our write — watcher ignores the echo
            await storage.WriteAsync(targetPath, copy, ct);
            state.Upsert(uid, targetPath, copy);
            search.IndexNote(uid, copy);
            await hub.Clients.All.SendAsync(keep == "right" ? "NoteUpdated" : "NoteCreated", NoteMetadata.From(copy), ct);
        }
    }

    // Every resolution deletes the rejected copy.
    writeRing.Mark(conflictPath);
    if (File.Exists(conflictPath)) File.Delete(conflictPath);
    conflictState.Remove(uid, id, out _);

    await hub.Clients.All.SendAsync("ConflictResolved", new { id, parentId = c.ParentId }, ct);
    return Results.NoContent();
});

// ── Search ────────────────────────────────────────────────────────────────────
// Relevance-ranked full-text search over the Lucene index. The index stores only
// metadata; snippets are highlighted against the live body in VaultState.
app.MapGet("/api/search", (string? q, ClaimsPrincipal user, SearchIndexService search, VaultState state) =>
{
    if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<object>());

    var uid = Uid(user);
    var results = search.Search(uid, q).Select(hit =>
    {
        var note = state.PathFor(uid, hit.Id) is { } p && state.TryGet(uid, p, out var n) ? n : null;
        var snippet = note is not null ? search.BuildSnippet(q, note.Body) : string.Empty;
        return new { id = hit.Id, title = hit.Title, snippet, score = hit.Score };
    }).ToArray();

    return Results.Ok(results);
}).RequireAuthorization();

// ── System: nuclear index rebuild ──────────────────────────────────────────────
// Wipe the disposable caches and rebuild them from the .md files (the authority).
// Broadcasts SystemRebuilding so clients can show a spinner while it runs.
app.MapPost("/api/system/rebuild-index", async (
    ClaimsPrincipal user,
    SearchIndexService search,
    MarkdownStorageService storage,
    VaultState state,
    VaultObserverOptions vault,
    AppDbContext db,
    IHubContext<NotesHub> hub,
    CancellationToken ct) =>
{
    await hub.Clients.All.SendAsync("SystemRebuilding", ct);

    var uid = Uid(user);
    var notesDir = vault.UserNotesDir(uid);
    Directory.CreateDirectory(notesDir);
    var scanned = new List<(Note Note, DateTime Mtime)>();
    foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
    {
        if (ConflictDetector.IsConflict(Path.GetFileName(path))) continue; // not a note
        var note = await storage.ReadAsync(path, ct);
        if (note is null || string.IsNullOrEmpty(note.Id)) continue;
        state.Upsert(uid, path, note);
        scanned.Add((note, File.GetLastWriteTimeUtc(path)));
    }

    search.RebuildUser(uid, scanned.Select(s => s.Note)); // drop only this tenant's docs

    // Refresh the caller's cache rows (disposable mirror; keyed by note id).
    var ids = scanned.Select(s => s.Note.Id).ToHashSet(StringComparer.Ordinal);
    db.NoteCache.RemoveRange(db.NoteCache.Where(r => ids.Contains(r.Id)));
    db.NoteCache.AddRange(scanned.Select(s => new NoteCache
    {
        Id = s.Note.Id,
        Title = s.Note.Title,
        Tags = string.Join(' ', s.Note.Tags),
        LastModified = s.Mtime,
    }));
    await db.SaveChangesAsync(ct);

    return Results.Ok(new { rebuilt = scanned.Count });
}).RequireAuthorization();

// ── Media uploads ───────────────────────────────────────────────────────────
// Attachments land flat in the media dir and are referenced from note bodies via
// ![[filename]]. Written atomically (tmp → flush → move) like notes; the nightly
// orphan-prune sweep reclaims anything no live note ends up referencing.
app.MapPost("/api/media/upload", async (
    string? noteId,
    IFormFile file,
    ClaimsPrincipal user,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file." });

    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, Uid(user));
    Directory.CreateDirectory(mediaDir);

    // Slugify the stem, keep the extension, append a short uuid so two pasted
    // "image.png"s never clobber each other.
    var ext = Path.GetExtension(file.FileName);
    var stem = Path.GetFileNameWithoutExtension(file.FileName);
    var safeStem = new string(stem.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray()).Trim('-');
    if (string.IsNullOrEmpty(safeStem)) safeStem = "file";
    var filename = $"{safeStem}-{Guid.NewGuid():N}{ext}";

    // Defensive: the slugified name can't escape, but verify before writing.
    var dest = PathGuard.ResolveAndVerify(mediaDir, filename, loggerFactory.CreateLogger("PathGuard"));
    var tmp = Path.Combine(mediaDir, $"{Guid.NewGuid():N}.tmp");
    await using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    {
        await file.CopyToAsync(fs, ct);
        await fs.FlushAsync(ct);
    }
    File.Move(tmp, dest);

    return Results.Ok(new { filename });
})
.RequireAuthorization()
.DisableAntiforgery(); // no antiforgery middleware in this skeleton; same-origin SPA

// ── Import / Export ───────────────────────────────────────────────────────────
// Import parks the uploaded archive on disk and hands it to the background queue,
// answering 202 with a job id; the SPA tracks progress via SignalR "ImportProgress".
// Export streams a zip of the caller's notes dir (deleted on close).
app.MapPost("/api/import/{provider}", async (
    string provider,
    IFormFile file,
    ClaimsPrincipal user,
    ImportService import,
    CancellationToken ct) =>
{
    if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file." });

    provider = provider.Trim().ToLowerInvariant();
    if (provider is not ("obsidian" or "keep"))
        return Results.BadRequest(new { error = "Unknown provider. Use 'obsidian' or 'keep'." });

    // Park the upload so the worker (not this request) owns the long parse.
    var tmp = Path.Combine(Path.GetTempPath(), $"papyra-import-{Guid.NewGuid():N}.zip");
    await using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    {
        await file.CopyToAsync(fs, ct);
        await fs.FlushAsync(ct);
    }

    var jobId = import.Enqueue(Uid(user), provider, tmp);
    return Results.Accepted(value: new { jobId });
})
.RequireAuthorization()
.DisableAntiforgery();

app.MapGet("/api/export", (
    ClaimsPrincipal user,
    IConfiguration config,
    IHostEnvironment env) =>
{
    var notesDir = PapyraPaths.UserNotesDir(config, env.ContentRootPath, Uid(user));
    Directory.CreateDirectory(notesDir);

    var tmp = Path.Combine(Path.GetTempPath(), $"papyra-export-{Guid.NewGuid():N}.zip");
    System.IO.Compression.ZipFile.CreateFromDirectory(notesDir, tmp);

    // DeleteOnClose reclaims the temp zip once the response stream finishes.
    var stream = new FileStream(
        tmp, FileMode.Open, FileAccess.Read, FileShare.None, 4096, FileOptions.DeleteOnClose);
    return Results.File(stream, "application/zip", "papyra-export.zip");
})
.RequireAuthorization();

app.MapHub<NotesHub>("/hubs/notes");

app.MapFallbackToFile("index.html");

app.Run();

// The authenticated tenant id, lifted from the NameIdentifier claim minted at
// sign-in. Every per-user storage path keys off this.
static string Uid(ClaimsPrincipal user) =>
    user.FindFirstValue(ClaimTypes.NameIdentifier)
    ?? throw new SecurityException("Authenticated principal carries no user id.");

// Mint the session cookie for a user. UserId rides as NameIdentifier so the
// services scope per-user storage (the Sprint 6.3 path jail keys off it).
static async Task SignInAsync(HttpContext http, User user)
{
    var claims = new List<Claim>
    {
        new(ClaimTypes.NameIdentifier, user.Id.ToString()),
        new(ClaimTypes.Name, user.Username),
        new(ClaimTypes.Role, user.Role),
    };
    var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
    await http.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
}

// PUT payload for an upsert. Id comes from the route; the body carries metadata +
// markdown. Foreign frontmatter on an existing file is preserved by the engine.
public sealed record NoteWrite(
    string? Title,
    List<string>? Tags,
    string? Color,
    bool Pinned,
    bool Archived,
    string? Body);

// First-admin bootstrap payload. Email/Name optional; username + password required.
public sealed record SetupRequest(
    string? Username,
    string? Name,
    string? Email,
    string? Password);

// Login payload. Both required; failures answer with a generic 401.
public sealed record LoginRequest(
    string? Username,
    string? Password);

// Admin-provisioned user. Username + password required; Role defaults to "User".
public sealed record ProvisionRequest(
    string? Username,
    string? Name,
    string? Email,
    string? Password,
    string? Role);

// Admin password reset payload for an existing user.
public sealed record ResetRequest(
    string? Password);

// Conflict resolution choice: "left" (keep parent), "right" (keep the copy),
// or "both" (promote the copy to a new note). The rejected .md is deleted either way.
public sealed record ResolveConflictRequest(
    string? Keep);

// Makes the implicit top-level Program class visible to WebApplicationFactory in integration tests.
public partial class Program { }
