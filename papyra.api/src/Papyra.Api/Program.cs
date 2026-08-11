using System.IO.Compression;
using System.Security;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// OpenAPI document for the /docs developer portal. A document transformer registers
// the personal-access-token scheme (X-API-Key) so the portal offers a token field
// and marks the endpoints as secured.
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, ct) =>
    {
        document.Info.Title = "Papyra API";
        document.Info.Description =
            "Self-hosted, file-first notes. Authenticate with a personal access token " +
            "(Settings → API Keys), sent as an `X-API-Key` header.";

        var apiKeyScheme = new Microsoft.OpenApi.OpenApiSecurityScheme
        {
            Type = Microsoft.OpenApi.SecuritySchemeType.ApiKey,
            In = Microsoft.OpenApi.ParameterLocation.Header,
            Name = "X-API-Key",
            Description = "Personal access token. Send as: X-API-Key: <token>",
        };

        document.Components ??= new Microsoft.OpenApi.OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, Microsoft.OpenApi.IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["ApiKey"] = apiKeyScheme;

        document.Security ??= [];
        document.Security.Add(new Microsoft.OpenApi.OpenApiSecurityRequirement
        {
            [new Microsoft.OpenApi.OpenApiSecuritySchemeReference("ApiKey", document)] = [],
        });
        return Task.CompletedTask;
    });
});

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

// Per-user manual note ordering (drag positions), persisted under .papyra/.
builder.Services.AddSingleton<OrderStore>();

// Per-user category registry (promoted tags + colours), persisted under .papyra/.
builder.Services.AddSingleton<CategoryStore>();

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

// AES-GCM encrypted, password-derived vault backups (generate + restore).
builder.Services.AddSingleton<EncryptedBackupService>();

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
// Registered as a singleton as well as a hosted service so the housekeeping
// endpoint can run the same sweep on demand — a 24h timer is not something an
// admin (or a test) can wait for.
builder.Services.AddSingleton<OrphanPruneService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OrphanPruneService>());

// Permanently purges trashed notes once they outlive the retention window.
builder.Services.AddHostedService<TrashPurgeService>();

// Hard-deletes expired / view-exhausted share links (burn-after-reading cleanup).
builder.Services.AddHostedService<ShareCleanupService>();

// Offline audio transcription (local Whisper). No-ops unless a model is configured.
builder.Services.AddHostedService<AudioTranscriptionService>();

// Local-only OCR of images in the media dir → searchable text. No-ops unless
// Tesseract tessdata is configured.
builder.Services.AddHostedService<OcrProcessorService>();

// Read-it-later web archiver: SSRF-guarded background fetch of URLs found in notes.
// Singleton so the note-write endpoint enqueues onto the same instance the worker drains.
builder.Services.AddSingleton<WebArchiverService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WebArchiverService>());

// Event-driven outbound webhooks (HMAC-signed). Singleton so the note-write endpoint
// enqueues onto the same instance the dispatcher worker drains.
builder.Services.AddSingleton<WebhookDispatcherService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WebhookDispatcherService>());

// Native git sync of the notes vault. Singleton so the manual-trigger endpoint runs
// the same instance as the background loop. Idle until a remote is configured.
builder.Services.AddSingleton<GitSyncService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<GitSyncService>());

// ── WebAuthn (biometric gatekeeper) ─────────────────────────────────────────────
// Relying-party identity for platform authenticators. ServerDomain must be the bare
// host (no scheme/port); Origins must list every origin the SPA is served from — in
// dev that includes the Vite port. All signature/challenge/origin verification is
// delegated to Fido2NetLib.
builder.Services.AddFido2(options =>
{
    options.ServerDomain = builder.Configuration["WebAuthn:ServerDomain"] ?? "localhost";
    options.ServerName = "Papyra";
    var origins = builder.Configuration.GetSection("WebAuthn:Origins").Get<string[]>()
        ?? ["http://localhost:5173", "http://localhost:5220"];
    options.Origins = origins.ToHashSet();
});
// Local semantic index: chunks + embeds notes via Ollama into the SQLite vector
// cache. Singleton so the note-write endpoint enqueues onto the worker's instance.
builder.Services.AddSingleton<EmbeddingService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<EmbeddingService>());

// Retrieval-augmented chat over the vault (local Ollama LLM + the vector cache).
builder.Services.AddSingleton<RagChatService>();

// Pending challenges + unlock tokens outlive a request, so they're singletons; the
// service itself is scoped because IFido2 and the DbContext are.
builder.Services.AddSingleton<WebAuthnChallengeStore>();
builder.Services.AddSingleton<UnlockTokenStore>();
builder.Services.AddScoped<BiometricAuthService>();

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
// Optional OIDC SSO: enabled only when an Authority + ClientId are configured, so
// the default password-only deployment needs no IdP. SameSite must relax to Lax for
// the external redirect callback to carry the correlation cookie back.
var oidc = builder.Configuration.GetSection("Oidc").Get<OidcSettings>();
var oidcEnabled = !string.IsNullOrWhiteSpace(oidc?.Authority) && !string.IsNullOrWhiteSpace(oidc?.ClientId);

// The cookie is only as durable as the key ring that signs it. By default those
// keys live in the container's ephemeral filesystem, so every restart or image
// upgrade silently signed every user out (and, with the offline outbox, stranded
// queued edits behind a 401). Persist them on the mounted /data volume instead.
var keysDir = PapyraPaths.DataProtectionKeysDir(builder.Configuration, builder.Environment.ContentRootPath);
Directory.CreateDirectory(keysDir);
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(keysDir))
    // Pin the discriminator: it otherwise derives from the content root path,
    // which differs between `dotnet run` and the container image.
    .SetApplicationName("Papyra");

var authBuilder = builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme);

authBuilder.AddCookie(options =>
    {
        options.Cookie.Name = "papyra.auth";
        options.Cookie.HttpOnly = true;
        // OIDC bounces the browser to the IdP and back; a Strict cookie wouldn't ride
        // the cross-site return, so relax to Lax when SSO is on (still not None).
        options.Cookie.SameSite = oidcEnabled ? SameSiteMode.Lax : SameSiteMode.Strict;
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

if (oidcEnabled)
{
    authBuilder.AddOpenIdConnect("oidc", options =>
    {
        options.Authority = oidc!.Authority;
        options.ClientId = oidc.ClientId;
        options.ClientSecret = oidc.ClientSecret;
        options.ResponseType = "code";
        // The external identity is exchanged for our own cookie session, so the rest
        // of the app keeps reading the internal UserId claim as before.
        options.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        options.GetClaimsFromUserInfoEndpoint = true;
        options.SaveTokens = false;
        options.Scope.Add("email");
        options.Scope.Add("profile");
        options.CallbackPath = "/signin-oidc";
        options.Events = new Microsoft.AspNetCore.Authentication.OpenIdConnect.OpenIdConnectEvents
        {
            // JIT provisioning: map the external subject to an internal user (creating
            // one + its vault on first sight), then swap in an internal-claims
            // principal so the cookie carries our UserId (chroot key), not the IdP's.
            OnTokenValidated = async ctx =>
            {
                var sp = ctx.HttpContext.RequestServices;
                var db = sp.GetRequiredService<AppDbContext>();
                var observer = sp.GetRequiredService<VaultObserver>();

                var ext = ctx.Principal;
                var sub = ext?.FindFirstValue(ClaimTypes.NameIdentifier) ?? ext?.FindFirstValue("sub");
                if (string.IsNullOrEmpty(sub)) { ctx.Fail("OIDC token carries no subject."); return; }

                var user = await db.Users.FirstOrDefaultAsync(u => u.ExternalId == sub, ctx.HttpContext.RequestAborted);
                if (user is null)
                {
                    var email = ext?.FindFirstValue(ClaimTypes.Email) ?? ext?.FindFirstValue("email") ?? string.Empty;
                    var display = ext?.FindFirstValue("name") ?? ext?.FindFirstValue(ClaimTypes.Name) ?? email;
                    user = new User
                    {
                        Username = await UniqueSsoUsername(db, email, sub, ctx.HttpContext.RequestAborted),
                        Name = string.IsNullOrWhiteSpace(display) ? "SSO user" : display.Trim(),
                        Email = email.Trim(),
                        PasswordHash = string.Empty, // SSO account: no local password
                        Role = "User",
                        ExternalId = sub,
                    };
                    db.Users.Add(user);
                    await db.SaveChangesAsync(ctx.HttpContext.RequestAborted);
                    observer.WatchUser(user.Id.ToString()); // create + watch the tenant vault so PathGuard won't fail
                }

                var identity = new ClaimsIdentity(CookieAuthenticationDefaults.AuthenticationScheme);
                identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()));
                identity.AddClaim(new Claim(ClaimTypes.Name, user.Username));
                identity.AddClaim(new Claim(ClaimTypes.Role, user.Role));
                ctx.Principal = new ClaimsPrincipal(identity);
            },
        };
    });
}

builder.Services.AddAuthorization();

// CORS is a dev affordance: in prod the SPA is served same-origin from wwwroot,
// so cross-origin requests never happen. Enable it only in Development, or in prod
// when a self-hoster explicitly lists origins (split reverse-proxy deploy). Never a
// wildcard — credentialed requests require named origins anyway.
var configuredOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>();
var enableCors = builder.Environment.IsDevelopment() || configuredOrigins is { Length: > 0 };
var allowedOrigins = configuredOrigins ?? ["http://localhost:5173"];

if (enableCors)
{
    builder.Services.AddCors(options => options.AddPolicy("AllowedOrigins", policy =>
        policy.WithOrigins(allowedOrigins)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials()));
}

var app = builder.Build();

// Run migrations on boot so papyra.db materializes before ports open.
using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.Migrate();
}

if (enableCors) app.UseCors("AllowedOrigins");

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
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        var path = ctx.File.Name;
        // The service worker and the shell must be revalidated on every load, or
        // an upgrade never reaches an open tab: without an explicit header the
        // browser heuristically caches /sw.js and keeps serving the previous
        // worker, which keeps serving the previous bundle. /assets/* is content-
        // hashed, so that stays immutable and long-lived.
        if (path is "sw.js" or "index.html")
            ctx.Context.Response.Headers.CacheControl = "no-cache";
        else if (ctx.Context.Request.Path.StartsWithSegments("/assets"))
            ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    },
});

app.UseAuthentication();

// ── API-key auth ───────────────────────────────────────────────────────────────
// When a request arrives without a cookie session, resolve a personal-access-token
// from either the dedicated `X-API-Key: <token>` header or the standard
// `Authorization: Bearer <token>` form (SHA-256 lookup) and attach the owning user
// as the principal — built with the SAME UserId, so the key inherits the per-tenant
// chroot jail. The same RequireAuthorization endpoints then work for scripts and
// integrations, not just the browser.
app.Use(async (context, next) =>
{
    if (context.User.Identity?.IsAuthenticated != true)
    {
        var token = context.Request.Headers["X-API-Key"].ToString().Trim();
        if (token.Length == 0)
        {
            var header = context.Request.Headers.Authorization.ToString();
            if (header.StartsWith("Bearer ", StringComparison.Ordinal))
                token = header["Bearer ".Length..].Trim();
        }

        if (token.Length > 0)
        {
            var hash = Sha256Hex(token);
            var db = context.RequestServices.GetRequiredService<AppDbContext>();
            var key = await db.ApiKeys.FirstOrDefaultAsync(k => k.TokenHash == hash, context.RequestAborted);
            if (key is not null)
            {
                var user = await db.Users.FindAsync([key.UserId], context.RequestAborted);
                if (user is not null)
                {
                    key.LastUsedUtc = DateTime.UtcNow;
                    await db.SaveChangesAsync(context.RequestAborted);
                    context.User = new ClaimsPrincipal(new ClaimsIdentity(
                    [
                        new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
                        new Claim(ClaimTypes.Name, user.Username),
                        new Claim(ClaimTypes.Role, user.Role),
                    ], "ApiKey"));
                }
            }
        }
    }
    await next();
});

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

// OpenAPI document + Scalar developer portal, mounted at /docs. Deliberately
// reachable in prod (a carve-out from P8 hardening) so self-hosters get live API
// docs; the documented surface is the same authenticated endpoints, gated by a
// personal access token (X-API-Key) the reader pastes into the portal.
app.MapOpenApi();

app.MapScalarApiReference("/docs", options =>
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
var auth = app.MapGroup("/api/auth").WithTags("Auth");

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

// ── SSO (OIDC) ────────────────────────────────────────────────────────────────
// Anonymous. `providers` tells the login screen whether an SSO button belongs
// there; `login/sso` kicks off the OIDC challenge (→ IdP → /signin-oidc callback →
// cookie session via OnTokenValidated → back to the app).
auth.MapGet("/providers", () =>
    Results.Ok(new { sso = oidcEnabled, ssoName = string.IsNullOrWhiteSpace(oidc?.DisplayName) ? "SSO" : oidc!.DisplayName }));

auth.MapGet("/login/sso", () =>
{
    if (!oidcEnabled) return Results.NotFound(new { error = "SSO is not configured." });
    return Results.Challenge(new AuthenticationProperties { RedirectUri = "/" }, ["oidc"]);
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

// ── WebAuthn (biometric gatekeeper) ───────────────────────────────────────────
// Enrol a platform authenticator, then prove possession to mint a short-lived
// unlock token (consumed by secure notes in 17.2). Verification is delegated to
// Fido2NetLib; challenges are single-use and scoped to the signed-in user.
var webauthn = auth.MapGroup("/webauthn").RequireAuthorization().WithTags("WebAuthn");

webauthn.MapGet("/credentials", async (ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(principal));
    return Results.Ok(await db.WebAuthnCredentials
        .Where(c => c.UserId == uid)
        .Select(c => new { c.Id, c.Name, c.CreatedUtc, c.LastUsedUtc })
        .ToListAsync(ct));
});

webauthn.MapPost("/register/challenge", async (
    ClaimsPrincipal principal, AppDbContext db, BiometricAuthService bio, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    return Results.Text((await bio.RegisterChallengeAsync(user, ct)).ToJson(), "application/json");
});

webauthn.MapPost("/register/verify", async (
    WebAuthnRegisterRequest body, ClaimsPrincipal principal, AppDbContext db,
    BiometricAuthService bio, CancellationToken ct) =>
{
    if (body.Response is null) return Results.BadRequest(new { error = "Missing attestation response." });
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    try
    {
        var ok = await bio.RegisterVerifyAsync(user, body.Response, body.Name, ct);
        return ok
            ? Results.Ok(new { registered = true })
            : Results.BadRequest(new { error = "No pending registration challenge." });
    }
    catch (Fido2NetLib.Fido2VerificationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

webauthn.MapPost("/challenge", async (ClaimsPrincipal principal, BiometricAuthService bio, CancellationToken ct) =>
{
    var options = await bio.AssertChallengeAsync(int.Parse(Uid(principal)), ct);
    return options is null
        ? Results.BadRequest(new { error = "No authenticator registered.", code = "no_credential" })
        : Results.Text(options.ToJson(), "application/json");
});

webauthn.MapPost("/verify", async (
    WebAuthnAssertRequest body, ClaimsPrincipal principal, BiometricAuthService bio, CancellationToken ct) =>
{
    if (body.Response is null) return Results.BadRequest(new { error = "Missing assertion response." });
    var token = await bio.AssertVerifyAsync(int.Parse(Uid(principal)), body.Response, ct);
    // A failed assertion never explains why — don't help an attacker probe.
    return token is null
        ? Results.Json(new { error = "Verification failed." }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Ok(new { unlockToken = token });
});

webauthn.MapDelete("/credentials/{id:int}", async (
    int id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(principal));
    var credential = await db.WebAuthnCredentials.FirstOrDefaultAsync(c => c.Id == id && c.UserId == uid, ct);
    if (credential is null) return Results.NotFound();
    db.WebAuthnCredentials.Remove(credential);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── Profile (self-service) ──────────────────────────────────────────────────────
// The signed-in user edits their own display name + email, changes their password,
// and uploads an avatar. Avatar lives under the user's hidden .papyra dir (UI
// state, not the notes vault).
auth.MapPut("/profile", async (ProfileRequest body, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var id = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (!string.IsNullOrWhiteSpace(body.Name)) user.Name = body.Name.Trim();
    user.Email = body.Email?.Trim() ?? string.Empty;
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role });
}).RequireAuthorization();

auth.MapPost("/password", async (PasswordRequest body, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Next))
        return Results.BadRequest(new { error = "New password is required." });

    var id = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (!BCrypt.Net.BCrypt.Verify(body.Current ?? string.Empty, user.PasswordHash))
        return Results.Json(new { error = "Current password is incorrect." }, statusCode: StatusCodes.Status400BadRequest);

    user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Next);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
}).RequireAuthorization();

auth.MapPost("/avatar", async (
    IFormFile file, ClaimsPrincipal principal, IConfiguration config, IHostEnvironment env, CancellationToken ct) =>
{
    if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file." });

    var dir = PapyraPaths.UserDotPapyra(config, env.ContentRootPath, Uid(principal));
    Directory.CreateDirectory(dir);
    // One avatar per user: clear any prior file, then write avatar.<ext> atomically.
    foreach (var old in Directory.EnumerateFiles(dir, "avatar.*")) File.Delete(old);

    var ext = Path.GetExtension(file.FileName);
    if (string.IsNullOrEmpty(ext) || ext.Length > 5) ext = ".png";
    var dest = Path.Combine(dir, $"avatar{ext}");
    var tmp = Path.Combine(dir, $"{Guid.NewGuid():N}.tmp");
    await using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    {
        await file.CopyToAsync(fs, ct);
        await fs.FlushAsync(ct);
    }
    File.Move(tmp, dest, overwrite: true);
    return Results.Ok(new { ok = true });
}).RequireAuthorization().DisableAntiforgery();

auth.MapGet("/avatar", (ClaimsPrincipal principal, IConfiguration config, IHostEnvironment env) =>
{
    var dir = PapyraPaths.UserDotPapyra(config, env.ContentRootPath, Uid(principal));
    var file = Directory.Exists(dir) ? Directory.EnumerateFiles(dir, "avatar.*").FirstOrDefault() : null;
    if (file is null) return Results.NotFound();
    if (!new FileExtensionContentTypeProvider().TryGetContentType(file, out var contentType))
        contentType = "application/octet-stream";
    return Results.File(file, contentType);
}).RequireAuthorization();

// ── Admin user management ──────────────────────────────────────────────────────
// Role-gated provisioning for the settings Admin tab. Provisioned users get their
// tenant vault created + watched, same as the first-admin setup flow.
var admin = auth.MapGroup("/users").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

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

// Delete a user account. Refuses self-deletion (avoid locking yourself out) and
// removing the last admin. Clears the account's API keys + shares (owned and
// received); the user's note files stay on disk (the source of truth) so nothing
// is silently destroyed — a self-hoster can reclaim or re-import them.
admin.MapDelete("/{id:int}", async (int id, ClaimsPrincipal me, AppDbContext db, CancellationToken ct) =>
{
    if (id == int.Parse(Uid(me)))
        return Results.BadRequest(new { error = "You can't delete your own account." });

    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (user.Role == "Admin" && await db.Users.CountAsync(u => u.Role == "Admin", ct) <= 1)
        return Results.BadRequest(new { error = "Can't delete the last admin." });

    db.ApiKeys.RemoveRange(db.ApiKeys.Where(k => k.UserId == id));
    db.Shares.RemoveRange(db.Shares.Where(s => s.OwnerId == id || s.GranteeUserId == id));
    db.Users.Remove(user);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── Notes CRUD ───────────────────────────────────────────────────────────────
// Reads serve the in-memory vault (no disk hit); writes go through the atomic
// markdown engine, logging the path in the Write-Ring so the watcher ignores the
// echo. Filesystem stays the source of truth — VaultState is just a mirror.
var notes = app.MapGroup("/api/notes").RequireAuthorization().WithTags("Notes");

notes.MapGet("/", (ClaimsPrincipal user, VaultState state, DateTime? from, DateTime? to) =>
{
    var snap = state.Snapshot(Uid(user));
    // Inclusive day-range filter (heatmap cell → dashboard filter).
    if (from is not null || to is not null)
        snap = snap.Where(n =>
            (from is null || n.Updated.Date >= from.Value.Date) &&
            (to is null || n.Updated.Date <= to.Value.Date)).ToList();
    // `secure: true` bodies never ride the list — metadata only.
    return Results.Ok(snap.Select(RedactSecure));
})
    .WithSummary("List notes")
    .WithDescription("Returns the caller's notes (metadata + body) from the in-memory vault. Optional from/to filter by last-modified date.");

// Note activity by day (year → month → day → count) for the knowledge heatmap.
notes.MapGet("/activity", (ClaimsPrincipal user, VaultState state) =>
    Results.Ok(TemporalActivity.Group(state.Snapshot(Uid(user)).Where(n => !n.Trashed).Select(n => n.Updated))))
    .WithSummary("Note activity heatmap");

// Reveal a `secure: true` note's body. The ONLY route that serves it, and only in
// exchange for a live biometric unlock token belonging to this same user (see
// Sprint 17.1). Without one the body is never sent — the gate is server-side, so a
// bypassed client blur reveals nothing.
notes.MapGet("/{id}/secure", (
    string id, ClaimsPrincipal user, HttpRequest request, VaultState state, UnlockTokenStore unlockTokens) =>
{
    var uid = Uid(user);
    var token = request.Headers["X-Unlock-Token"].ToString();
    if (!unlockTokens.IsValid(token, uid))
        return Results.Json(new { error = "Unlock required.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);

    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();
    return Results.Ok(new { note.Id, note.Title, note.Body });
})
    .WithSummary("Reveal a secure note's body")
    .WithDescription("Requires a valid X-Unlock-Token from a successful WebAuthn assertion; 401 otherwise.");

// ── Manual ordering (drag-and-drop) ──────────────────────────────────────────
// The grid default-sorts by `updated` (recency); a manual drag overrides that by
// pinning a note to a fractional Key. `SetAt` is the note's mtime at drag time, so
// the client can ignore a stale Key once the note is edited again (edit → top).
// Literal "/order" outranks the "/{id}" param route, so there's no collision.
notes.MapGet("/order", (ClaimsPrincipal user, OrderStore order) =>
    Results.Ok(order.Read(Uid(user))));

notes.MapPut("/order", (OrderWrite body, ClaimsPrincipal user, OrderStore order) =>
{
    var map = (body.Entries ?? [])
        .Where(e => !string.IsNullOrEmpty(e.Id))
        .ToDictionary(e => e.Id, e => new OrderStore.Entry(e.Key, e.SetAt), StringComparer.Ordinal);
    order.Write(Uid(user), map);
    return Results.Ok(map);
});

notes.MapPut("/{id}", async (
    string id,
    NoteWrite body,
    ClaimsPrincipal user,
    VaultState state,
    MarkdownStorageService storage,
    WriteRing writeRing,
    SearchIndexService search,
    SnapshotService snapshots,
    WebArchiverService archiver,
    WebhookDispatcherService webhooks,
    EmbeddingService embeddings,
    VaultObserverOptions vault,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    // The id becomes the .md filename. PathGuard stops it escaping the vault, but
    // a name like `..%2F..%2Fetc%2Fpasswd` still landed as a literal file the API
    // could never address again — reject it up front instead.
    if (!PathGuard.IsValidNoteId(id))
        return Results.BadRequest(new { error = "Invalid note id." });

    var uid = Uid(user);
    // Capture the prior revision (if any) so we can diff for webhook events below.
    var priorPath = state.PathFor(uid, id);
    Note? prior = null;
    if (priorPath is not null) state.TryGet(uid, priorPath, out prior);

    // Resolve under the caller's vault and verify it can't escape (→ 403).
    var path = priorPath
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
        Kind = string.Equals(body.Kind, "todo", StringComparison.OrdinalIgnoreCase) ? "todo" : "note",
        // Omitted `secure` keeps whatever the note already had — a client that
        // doesn't know about the flag must never silently unlock a secure note.
        Secure = body.Secure ?? prior?.Secure ?? false,
        Updated = DateTime.UtcNow,
    };

    // Snapshot the prior on-disk revision before we overwrite it (throttled).
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, loggerFactory.CreateLogger("PathGuard"));
    await snapshots.CaptureAsync(noteSnapDir, path, ct);

    writeRing.Mark(path); // log self-write before touching disk (loop prevention)
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.IndexNote(uid, note); // watcher skips our own write echo, so index here

    archiver.Enqueue(uid, id, note.Body); // background-archive any new URLs in the body

    // Re-embed for semantic search — but never a secure note: its chunks would sit
    // in the vector cache as plaintext, outside the unlock gate.
    if (!note.Secure) embeddings.Enqueue(uid, id, note.Body);

    // Fire webhook events off the diff against the prior revision.
    if (prior is null)
        webhooks.Enqueue(uid, WebhookEvents.NoteCreated, WebhookPayload(WebhookEvents.NoteCreated, note));
    else
    {
        if (prior.Pinned != note.Pinned)
            webhooks.Enqueue(uid, WebhookEvents.PinToggled, WebhookPayload(WebhookEvents.PinToggled, note));
        if (note.Tags.Except(prior.Tags, StringComparer.OrdinalIgnoreCase).Any())
            webhooks.Enqueue(uid, WebhookEvents.TagAdded, WebhookPayload(WebhookEvents.TagAdded, note));
    }

    return Results.Ok(note);
});

notes.MapDelete("/{id}", async (
    string id,
    ClaimsPrincipal user,
    VaultState state,
    WriteRing writeRing,
    SearchIndexService search,
    EmbeddingService embeddings,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null) return Results.NotFound();

    writeRing.Mark(path); // watcher ignores the delete echo
    if (File.Exists(path)) File.Delete(path);
    state.Remove(uid, path);
    search.RemoveNote(id); // watcher skips the echo, so drop from the index here
    await embeddings.RemoveNoteAsync(uid, id, ct); // and drop its vectors

    return Results.NoContent();
});

// ── Soft-delete (trash / restore) ───────────────────────────────────────────────
// Trash flips the frontmatter flag + stamps TrashedAt; the note stays on disk
// (recoverable) until the retention sweep purges it. DELETE above is the permanent
// purge. Restore clears the flag and re-indexes the note.
notes.MapPost("/{id}/trash", async (
    string id, ClaimsPrincipal user, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    EmbeddingService embeddings, CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();

    note.Trashed = true;
    note.TrashedAt = DateTime.UtcNow;
    writeRing.Mark(path);
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.RemoveNote(id); // hidden from search while trashed
    await embeddings.RemoveNoteAsync(uid, id, ct); // and from semantic search + RAG
    return Results.NoContent();
});

notes.MapPost("/{id}/untrash", async (
    string id, ClaimsPrincipal user, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    EmbeddingService embeddings, CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();

    note.Trashed = false;
    note.TrashedAt = null;
    writeRing.Mark(path);
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.IndexNote(uid, note);
    // Restore semantic coverage too — the vectors were dropped when it was trashed.
    if (!note.Secure) embeddings.Enqueue(uid, id, note.Body);
    return Results.NoContent();
});

// ── Backlinks (ghost cards) ──────────────────────────────────────────────────────
// Notes that link to this one via a `[[Title]]` wikilink. Detection runs against
// the in-memory vault (the authority) by literal substring — Lucene's analyzer
// strips the `[[ ]]` brackets, so an exact wikilink match isn't reliable there; the
// highlighter still builds the ~150-char snippet around the title mention.
notes.MapGet("/{id}/backlinks", (string id, ClaimsPrincipal user, VaultState state, SearchIndexService search) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var target) || target is null) return Results.NotFound();

    var title = target.Title;
    if (string.IsNullOrWhiteSpace(title)) return Results.Ok(Array.Empty<object>());

    var needle = $"[[{title}]]";
    var results = state.Snapshot(uid)
        .Where(n => !n.Trashed && n.Id != id && !string.IsNullOrEmpty(n.Body)
                    && n.Body.Contains(needle, StringComparison.OrdinalIgnoreCase))
        .Select(n => new
        {
            noteId = n.Id,
            title = n.Title,
            snippet = search.BuildSnippet(title, n.Body),
            color = n.Color,
        })
        .ToList();

    return Results.Ok(results);
})
    .WithSummary("List backlinks")
    .WithDescription("Notes that reference this note through a [[Title]] wikilink, each with a highlighted snippet.");

// ── Categories (promoted tags) ───────────────────────────────────────────────────
// A category is a curated note tag. The notes' own `tags` frontmatter is the
// authority for membership; the registry (.papyra/categories.json) only adds a
// colour and lets an empty category exist before any note uses it. GET unions the
// registry with every tag live on the user's notes, attaching a count to each.
var categories = app.MapGroup("/api/categories").RequireAuthorization().WithTags("Categories");

categories.MapGet("/", (ClaimsPrincipal user, VaultState state, CategoryStore store) =>
{
    var uid = Uid(user);
    var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    var display = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var note in state.Snapshot(uid).Where(n => !n.Trashed))
        foreach (var tag in note.Tags)
        {
            if (string.IsNullOrWhiteSpace(tag)) continue;
            counts[tag] = counts.GetValueOrDefault(tag) + 1;
            display.TryAdd(tag, tag);
        }

    var colors = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
    foreach (var c in store.Read(uid))
    {
        display.TryAdd(c.Name, c.Name);
        colors[c.Name] = c.Color;
    }

    var result = display.Values
        .Select(name => new
        {
            name,
            color = colors.GetValueOrDefault(name),
            count = counts.GetValueOrDefault(name),
        })
        .OrderByDescending(c => c.count)
        .ThenBy(c => c.name, StringComparer.OrdinalIgnoreCase)
        .ToList();

    return Results.Ok(result);
});

categories.MapPost("/", (CategoryWrite body, ClaimsPrincipal user, CategoryStore store) =>
{
    var name = body.Name?.Trim();
    if (string.IsNullOrWhiteSpace(name))
        return Results.BadRequest(new { error = "Category name is required." });
    store.Upsert(Uid(user), name, string.IsNullOrWhiteSpace(body.Color) ? null : body.Color);
    return Results.Ok(new { name, color = body.Color });
});

categories.MapDelete("/{name}", (string name, ClaimsPrincipal user, CategoryStore store) =>
{
    store.Remove(Uid(user), name);
    return Results.NoContent();
});

// ── API keys (personal access tokens) ────────────────────────────────────────────
// The raw token is returned exactly once at creation; only its SHA-256 hash is
// stored. Use it as `Authorization: Bearer <token>` (see the bearer middleware).
var keys = app.MapGroup("/api/keys").RequireAuthorization().WithTags("API Keys");

keys.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    return Results.Ok(await db.ApiKeys
        .Where(k => k.UserId == uid)
        .OrderByDescending(k => k.CreatedUtc)
        .Select(k => new { k.Id, k.Name, k.Prefix, k.CreatedUtc, k.LastUsedUtc })
        .ToListAsync(ct));
});

keys.MapPost("/", async (ApiKeyWrite body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var name = string.IsNullOrWhiteSpace(body.Name) ? "Untitled key" : body.Name.Trim();

    // 32 bytes of entropy → high enough that a plain SHA-256 (no per-row bcrypt) is
    // a safe, fast lookup key.
    var raw = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
    var secret = Convert.ToBase64String(raw).Replace("+", "").Replace("/", "").Replace("=", "");
    var token = $"papyra_{secret}";
    var prefix = token[..14];

    var key = new ApiKey
    {
        UserId = uid,
        Name = name,
        Prefix = prefix,
        TokenHash = Sha256Hex(token),
        CreatedUtc = DateTime.UtcNow,
    };
    db.ApiKeys.Add(key);
    await db.SaveChangesAsync(ct);

    // token is shown to the caller this once, never persisted in the clear.
    return Results.Ok(new { key.Id, key.Name, key.Prefix, key.CreatedUtc, token });
})
    .WithSummary("Create API key")
    .WithDescription("Generates a personal access token. The raw token is returned once — store it; only its hash is kept.");

keys.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var key = await db.ApiKeys.FirstOrDefaultAsync(k => k.Id == id && k.UserId == uid, ct);
    if (key is null) return Results.NotFound();
    db.ApiKeys.Remove(key);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── Smart collections (saved searches) ────────────────────────────────────────────
// A collection is a named AND/OR rule set evaluated live against the vault. Notes are
// never moved — they stay on the main feed; a collection is just a view.
// Rules arrive as camelCase JSON from the rule builder.
var JsonOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var collections = app.MapGroup("/api/collections").RequireAuthorization().WithTags("Collections");

collections.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    return Results.Ok(await db.SmartCollections
        .Where(c => c.UserId == uid)
        .OrderBy(c => c.Name)
        .Select(c => new { c.Id, c.Name, c.RulesJson, c.CreatedUtc })
        .ToListAsync(ct));
});

collections.MapPost("/", async (SmartCollectionWrite body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var name = body.Name?.Trim();
    if (string.IsNullOrWhiteSpace(name)) return Results.BadRequest(new { error = "Name is required." });

    // Validate the rules round-trip before persisting so a collection can't be saved broken.
    SmartRules? rules;
    try { rules = JsonSerializer.Deserialize<SmartRules>(body.RulesJson ?? "", JsonOpts); }
    catch (JsonException) { return Results.BadRequest(new { error = "rulesJson is not valid JSON." }); }
    if (rules?.Conditions is null || rules.Conditions.Count == 0)
        return Results.BadRequest(new { error = "At least one condition is required." });

    var collection = new SmartCollection
    {
        UserId = int.Parse(Uid(user)),
        Name = name,
        RulesJson = body.RulesJson!,
        CreatedUtc = DateTime.UtcNow,
    };
    db.SmartCollections.Add(collection);
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { collection.Id, collection.Name, collection.RulesJson, collection.CreatedUtc });
});

collections.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var collection = await db.SmartCollections.FirstOrDefaultAsync(c => c.Id == id && c.UserId == uid, ct);
    if (collection is null) return Results.NotFound();
    db.SmartCollections.Remove(collection);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// Run a saved collection: evaluate its rules over the live vault.
collections.MapGet("/{id:int}/notes", async (
    int id, ClaimsPrincipal user, AppDbContext db, VaultState state, CancellationToken ct) =>
{
    var uid = Uid(user);
    var collection = await db.SmartCollections
        .FirstOrDefaultAsync(c => c.Id == id && c.UserId == int.Parse(uid), ct);
    if (collection is null) return Results.NotFound();

    SmartRules? rules;
    try { rules = JsonSerializer.Deserialize<SmartRules>(collection.RulesJson, JsonOpts); }
    catch (JsonException) { return Results.BadRequest(new { error = "Stored rules are invalid." }); }
    if (rules is null) return Results.Ok(Array.Empty<Note>());

    return Results.Ok(state.Snapshot(uid)
        .Where(n => !n.Trashed && SmartCollectionEvaluator.Matches(n, rules)));
});

// ── Webhooks (event-driven outbound) ──────────────────────────────────────────────
// Register a URL to receive HMAC-signed JSON when NoteCreated/TagAdded/PinToggled
// fires for the caller's notes. The secret is returned once at creation (stored in
// the clear since HMAC needs the raw key); the list never re-exposes it.
var webhooksApi = app.MapGroup("/api/webhooks").RequireAuthorization().WithTags("Webhooks");

webhooksApi.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    return Results.Ok(await db.Webhooks
        .Where(w => w.UserId == uid)
        .OrderByDescending(w => w.CreatedUtc)
        .Select(w => new { w.Id, w.TriggerEvent, w.WebhookUrl, w.CreatedUtc })
        .ToListAsync(ct));
});

webhooksApi.MapPost("/", async (WebhookWrite body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Event) || !WebhookEvents.All.Contains(body.Event))
        return Results.BadRequest(new { error = $"event must be one of: {string.Join(", ", WebhookEvents.All)}." });
    if (!Uri.TryCreate(body.Url, UriKind.Absolute, out var uri) ||
        (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        return Results.BadRequest(new { error = "url must be an absolute http(s) URL." });

    // Use the caller's secret if supplied, else generate one and return it once.
    var secret = string.IsNullOrWhiteSpace(body.Secret)
        ? Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant()
        : body.Secret.Trim();

    var hook = new Webhook
    {
        UserId = int.Parse(Uid(user)),
        TriggerEvent = body.Event,
        WebhookUrl = uri.ToString(),
        SecretKey = secret,
        CreatedUtc = DateTime.UtcNow,
    };
    db.Webhooks.Add(hook);
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { hook.Id, hook.TriggerEvent, hook.WebhookUrl, hook.CreatedUtc, secret });
});

webhooksApi.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var hook = await db.Webhooks.FirstOrDefaultAsync(w => w.Id == id && w.UserId == uid, ct);
    if (hook is null) return Results.NotFound();
    db.Webhooks.Remove(hook);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── Git sync (admin) ──────────────────────────────────────────────────────────────
// Configure + trigger native git backup of the notes vault. Admin-only. The token is
// stored in the clear (git auth needs the raw PAT) and never returned; the read shows
// only whether one is set, plus the last-sync/conflict status.
var gitApi = app.MapGroup("/api/git").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Git");

gitApi.MapGet("/", async (AppDbContext db, CancellationToken ct) =>
{
    var settings = await db.Settings
        .Where(s => s.Key.StartsWith("git."))
        .ToDictionaryAsync(s => s.Key, s => s.Value, ct);
    string? Get(string k) => settings.GetValueOrDefault(k);
    return Results.Ok(new
    {
        remoteUrl = Get("git.remoteUrl") ?? string.Empty,
        branch = string.IsNullOrWhiteSpace(Get("git.branch")) ? "main" : Get("git.branch"),
        hasToken = !string.IsNullOrEmpty(Get("git.token")),
        conflict = Get("git.conflict") == "true",
        lastSyncUtc = string.IsNullOrEmpty(Get("git.lastSyncUtc")) ? null : Get("git.lastSyncUtc"),
        lastError = string.IsNullOrEmpty(Get("git.lastError")) ? null : Get("git.lastError"),
    });
});

gitApi.MapPut("/", async (GitConfigWrite body, AppDbContext db, CancellationToken ct) =>
{
    async Task Set(string key, string value)
    {
        var row = await db.Settings.FindAsync([key], ct);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
    }

    await Set("git.remoteUrl", body.RemoteUrl?.Trim() ?? string.Empty);
    await Set("git.branch", string.IsNullOrWhiteSpace(body.Branch) ? "main" : body.Branch.Trim());
    // Only overwrite the token when one is supplied, so saving config doesn't wipe it.
    if (body.Token is not null) await Set("git.token", body.Token.Trim());
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
})
    .WithSummary("Configure git mirroring (admin, whole instance)")
    .WithDescription(
        "Sets the remote for the git mirror. NOTE: the repository is the whole users " +
        "directory, so a sync pushes EVERY tenant's notes and media to this remote — " +
        "not only the admin's own vault. On a shared instance, treat the remote as " +
        "having the same trust level as the server itself. Papyra's own state " +
        "(.papyra/, .trash/) is gitignored.");

gitApi.MapPost("/sync", async (GitSyncService git, CancellationToken ct) =>
{
    var result = await git.SyncOnceAsync(ct);
    return Results.Ok(new { result.Status, result.Detail });
})
    .WithSummary("Run a git sync now (admin)")
    .WithDescription(
        "Stages, commits and pushes every tenant's vault. Returns status 'pushed', " +
        "'clean', or 'conflict' — a diverged remote is never force-pushed; the " +
        "conflict flag is raised instead and the remote is left untouched.");

// ── Settings (trash retention) ───────────────────────────────────────────────────
// Single global key for now: how long trashed notes survive before the sweep
// purges them. -1 = keep forever, 0 = purge immediately, else N days.
var settings = app.MapGroup("/api/settings").RequireAuthorization().WithTags("Settings");

settings.MapGet("/", async (AppDbContext db, CancellationToken ct) =>
    Results.Ok(new { trashRetentionDays = await TrashRetention.ReadDays(db, ct) }));

settings.MapPut("/", async (SettingsRequest body, AppDbContext db, CancellationToken ct) =>
{
    if (!TrashRetention.Allowed.Contains(body.TrashRetentionDays))
        return Results.BadRequest(new { error = "Invalid retention value." });

    var row = await db.Settings.FindAsync([TrashRetention.Key], ct);
    if (row is null) db.Settings.Add(new AppSetting { Key = TrashRetention.Key, Value = body.TrashRetentionDays.ToString() });
    else row.Value = body.TrashRetentionDays.ToString();
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { trashRetentionDays = body.TrashRetentionDays });
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
var conflicts = app.MapGroup("/api/conflicts").RequireAuthorization().WithTags("Conflicts");

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
    SnapshotService snapshots,
    VaultObserverOptions vault,
    IConfiguration config,
    IHostEnvironment env,
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

            // "Keep Right" overwrites the parent with the other device's text. Snapshot
            // the revision being replaced first — otherwise the losing side of a
            // conflict is gone for good, which is the opposite of what a conflict
            // resolver is for. (Same guarantee the restore endpoint already gives.)
            if (keep == "right")
            {
                var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
                var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, c.ParentId, logger);
                await snapshots.CaptureAsync(noteSnapDir, targetPath, ct);
            }

            writeRing.Mark(targetPath); // our write — watcher ignores the echo
            await storage.WriteAsync(targetPath, copy, ct);
            state.Upsert(uid, targetPath, copy);
            search.IndexNote(uid, copy);
            await hub.Clients.All.SendAsync(keep == "right" ? "NoteUpdated" : "NoteCreated", NoteMetadata.From(copy), ct);
        }
    }

    // Every resolution retires the rejected copy — but into the tenant's .trash,
    // never with a hard delete. It is another device's copy of the user's own
    // writing, and this is the only irreversible step in the whole flow.
    writeRing.Mark(conflictPath);
    if (File.Exists(conflictPath))
    {
        try
        {
            var trashDir = PapyraPaths.UserTrashDir(config, env.ContentRootPath, uid);
            Directory.CreateDirectory(trashDir);
            var retired = Path.Combine(trashDir, $"{DateTime.UtcNow.Ticks}-{Path.GetFileName(conflictPath)}");
            File.Move(conflictPath, retired, overwrite: true);
        }
        catch (IOException)
        {
            File.Delete(conflictPath); // trash unavailable — resolution still has to complete
        }
    }
    conflictState.Remove(uid, id, out _);

    await hub.Clients.All.SendAsync("ConflictResolved", new { id, parentId = c.ParentId }, ct);
    return Results.NoContent();
});

// ── Sharing ─────────────────────────────────────────────────────────────────────
// Two kinds of grant: public tokenised links (optional expiry + view-count cap)
// and internal user-to-user shares. The note stays in the owner's vault; a Share
// row is just an authorisation pointer. Owners manage shares per note; the public
// link is anonymous; the grantee reaches incoming shares through their session.

// Owner: list a note's shares (with grantee usernames resolved).
notes.MapGet("/{id}/shares", async (string id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.Shares.Where(s => s.OwnerId == uid && s.NoteId == id)
        .OrderByDescending(s => s.CreatedUtc).ToListAsync(ct);
    var granteeIds = rows.Where(s => s.GranteeUserId != null).Select(s => s.GranteeUserId!.Value).ToHashSet();
    var names = await db.Users.Where(u => granteeIds.Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => u.Username, ct);
    return Results.Ok(rows.Select(s => new
    {
        s.Id, s.Kind, s.Access, s.Token, s.ExpiresUtc, s.MaxViews, s.ViewCount,
        grantee = s.GranteeUserId is { } g && names.TryGetValue(g, out var n) ? n : null,
    }));
});

// Owner: create a share for a note.
notes.MapPost("/{id}/shares", async (string id, ShareWrite body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var kind = body.Kind?.Trim().ToLowerInvariant();
    var access = body.Access?.Trim().ToLowerInvariant() == "edit" ? "edit" : "view";
    if (kind is not ("link" or "user")) return Results.BadRequest(new { error = "kind must be link or user." });

    var share = new Share
    {
        NoteId = id, OwnerId = uid, Kind = kind, Access = access,
        ExpiresUtc = body.ExpiresUtc,
        MaxViews = body.MaxViews is > 0 ? body.MaxViews : null,
        CreatedUtc = DateTime.UtcNow,
    };

    if (kind == "user")
    {
        var uname = body.GranteeUsername?.Trim();
        if (string.IsNullOrWhiteSpace(uname)) return Results.BadRequest(new { error = "granteeUsername is required." });
        var grantee = await db.Users.FirstOrDefaultAsync(u => u.Username == uname, ct);
        if (grantee is null) return Results.NotFound(new { error = "No such user." });
        if (grantee.Id == uid) return Results.BadRequest(new { error = "You already own this note." });
        share.GranteeUserId = grantee.Id;
    }
    else
    {
        var raw = System.Security.Cryptography.RandomNumberGenerator.GetBytes(24);
        share.Token = Convert.ToBase64String(raw).Replace("+", "").Replace("/", "").Replace("=", "");
    }

    db.Shares.Add(share);
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { share.Id, share.Kind, share.Access, share.Token, share.ExpiresUtc, share.MaxViews });
});

// Owner: revoke any of their own shares.
var shares = app.MapGroup("/api/shares").RequireAuthorization().WithTags("Sharing");

shares.MapDelete("/{shareId:int}", async (int shareId, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.OwnerId == uid, ct);
    if (share is null) return Results.NotFound();
    db.Shares.Remove(share);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// Grantee: notes shared *with me* by other users.
shares.MapGet("/incoming", async (
    ClaimsPrincipal user, AppDbContext db, VaultState state, MarkdownStorageService storage,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.Shares.Where(s => s.GranteeUserId == uid && s.Kind == "user").ToListAsync(ct);
    var ownerNames = await db.Users.Where(u => rows.Select(r => r.OwnerId).Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => u.Username, ct);

    var result = new List<object>();
    foreach (var s in rows)
    {
        var note = await storage.ReadAsync(OwnerNotePath(state, vault, lf, s.OwnerId.ToString(), s.NoteId), ct);
        result.Add(new
        {
            shareId = s.Id, noteId = s.NoteId, access = s.Access,
            owner = ownerNames.GetValueOrDefault(s.OwnerId, "?"),
            title = note?.Title ?? string.Empty,
        });
    }
    return Results.Ok(result);
});

// Grantee: read one incoming shared note.
shares.MapGet("/incoming/{shareId:int}", async (
    int shareId, ClaimsPrincipal user, AppDbContext db, VaultState state, MarkdownStorageService storage,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
    if (share is null) return Results.NotFound();
    var note = await storage.ReadAsync(OwnerNotePath(state, vault, lf, share.OwnerId.ToString(), share.NoteId), ct);
    if (note is null) return Results.NotFound();
    return Results.Ok(new { note.Title, note.Body, note.Color, access = share.Access });
});

// Grantee: media embedded in an incoming shared note (resolved in owner's vault).
shares.MapGet("/incoming/{shareId:int}/media/{filename}", async (
    int shareId, string filename, ClaimsPrincipal user, AppDbContext db,
    IConfiguration config, IHostEnvironment env, ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
    if (share is null) return Results.NotFound();
    return ServeOwnerMedia(share.OwnerId.ToString(), filename, config, env, lf);
});

// Grantee: edit an incoming shared note (only when access == edit).
shares.MapPut("/incoming/{shareId:int}", async (
    int shareId, SharedBodyWrite body, ClaimsPrincipal user, AppDbContext db, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    SnapshotService snapshots, IConfiguration config, IHostEnvironment env,
    IHubContext<NotesHub> hub, VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
    if (share is null) return Results.NotFound();
    if (share.Access != "edit") return Results.Forbid();
    return await ApplySharedEdit(share.OwnerId.ToString(), share.NoteId, body.Body ?? string.Empty,
        state, storage, writeRing, search, snapshots, config, env, hub, vault, lf, ct);
});

// Public: read a link-shared note (enforces expiry + view cap, counts the view).
app.MapGet("/api/shared/{token}", async (
    string token, AppDbContext db, VaultState state, MarkdownStorageService storage,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
    if (share is null) return Results.NotFound();
    if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
        return Results.Json(new { error = "This link has expired." }, statusCode: StatusCodes.Status410Gone);
    if (share.MaxViews is { } mv && share.ViewCount >= mv)
        return Results.Json(new { error = "This link has reached its view limit." }, statusCode: StatusCodes.Status410Gone);

    share.ViewCount++;
    await db.SaveChangesAsync(ct);
    var note = await storage.ReadAsync(OwnerNotePath(state, vault, lf, share.OwnerId.ToString(), share.NoteId), ct);
    if (note is null) return Results.NotFound();
    return Results.Ok(new { note.Title, note.Body, note.Color, access = share.Access });
});

// Public: media embedded in a link-shared note. No session needed; the token is
// the authorisation. Validity (expiry) is enforced; media GETs don't count a view.
app.MapGet("/api/shared/{token}/media/{filename}", async (
    string token, string filename, AppDbContext db,
    IConfiguration config, IHostEnvironment env, ILoggerFactory lf, CancellationToken ct) =>
{
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
    if (share is null) return Results.NotFound();
    if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
        return Results.Json(new { error = "This link has expired." }, statusCode: StatusCodes.Status410Gone);
    return ServeOwnerMedia(share.OwnerId.ToString(), filename, config, env, lf);
});

// Public: edit a link-shared note (only when access == edit; doesn't count a view).
app.MapPut("/api/shared/{token}", async (
    string token, SharedBodyWrite body, AppDbContext db, VaultState state, MarkdownStorageService storage,
    WriteRing writeRing, SearchIndexService search, SnapshotService snapshots,
    IConfiguration config, IHostEnvironment env, IHubContext<NotesHub> hub,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
    if (share is null) return Results.NotFound();
    if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
        return Results.Json(new { error = "This link has expired." }, statusCode: StatusCodes.Status410Gone);
    if (share.Access != "edit") return Results.Forbid();
    return await ApplySharedEdit(share.OwnerId.ToString(), share.NoteId, body.Body ?? string.Empty,
        state, storage, writeRing, search, snapshots, config, env, hub, vault, lf, ct);
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
        // A secure note stays findable by title, but its body must never leak
        // through a search snippet — that would defeat the unlock gate.
        var snippet = note is not null && !note.Secure ? search.BuildSnippet(q, note.Body) : string.Empty;
        return new { id = hit.Id, title = hit.Title, snippet, score = hit.Score, secure = note?.Secure ?? false };
    }).ToArray();

    return Results.Ok(results);
}).RequireAuthorization();

// ── Semantic search (local embeddings) ────────────────────────────────────────
// Meaning-based retrieval: the query is embedded and compared by cosine similarity
// against the note chunks, so "marketing spend" can surface an "Advertising budget"
// note that shares no keywords. Falls back to nothing when Ollama is absent —
// callers should keep using /api/search for keyword results.
app.MapGet("/api/search/semantic", async (
    string? q, int? take, ClaimsPrincipal user, EmbeddingService embeddings,
    VaultState state, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<object>());

    var uid = Uid(user);
    var hits = await embeddings.SearchAsync(uid, q, Math.Clamp(take ?? 5, 1, 25), ct);
    return Results.Ok(hits.Select(h =>
    {
        var note = state.PathFor(uid, h.NoteId) is { } p && state.TryGet(uid, p, out var n) ? n : null;
        return new { id = h.NoteId, title = note?.Title ?? string.Empty, snippet = h.Text, score = h.Score };
    }));
}).RequireAuthorization();

// ── Conversational RAG ────────────────────────────────────────────────────────
// Ask a question of your own notes. The prompt is embedded, the closest chunks are
// retrieved, and a local LLM answers grounded in them. Responds as newline-delimited
// JSON so the client can render citations immediately and stream the answer:
//   {"type":"citations", ...} → {"type":"token", ...}* → {"type":"done"}
// Secure notes are never embedded, so they can never be retrieved into an answer.
app.MapPost("/api/ai/chat", async (
    AiChatRequest body, ClaimsPrincipal user, RagChatService rag, HttpContext http, CancellationToken ct) =>
{
    var question = body.Question?.Trim();
    if (string.IsNullOrWhiteSpace(question))
        return Results.BadRequest(new { error = "A question is required." });

    var citations = await rag.RetrieveAsync(Uid(user), question, ct);

    http.Response.ContentType = "application/x-ndjson";
    var writer = new StreamWriter(http.Response.Body);

    await writer.WriteLineAsync(JsonSerializer.Serialize(new
    {
        type = "citations",
        citations = citations.Select(c => new { noteId = c.NoteId, title = c.Title, snippet = c.Snippet, score = c.Score }),
    }));
    await writer.FlushAsync(ct);

    var any = false;
    await foreach (var token in rag.StreamAnswerAsync(question, citations, ct))
    {
        any = true;
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "token", value = token }));
        await writer.FlushAsync(ct); // flush per token so the UI streams
    }

    // No tokens at all means the local model wasn't reachable — say so plainly
    // rather than leaving the client with an empty answer.
    await writer.WriteLineAsync(JsonSerializer.Serialize(
        any ? new { type = "done", error = (string?)null }
            : new { type = "done", error = (string?)"The local model is unavailable." }));
    await writer.FlushAsync(ct);
    return Results.Empty;
}).RequireAuthorization();

// Rebuild the whole semantic index from the vault (vectors are a disposable cache).
app.MapPost("/api/system/rebuild-embeddings", (
    ClaimsPrincipal user, VaultState state, EmbeddingService embeddings) =>
{
    var uid = Uid(user);
    var queued = 0;
    foreach (var note in state.Snapshot(uid).Where(n => !n.Trashed && !n.Secure))
    {
        embeddings.Enqueue(uid, note.Id, note.Body);
        queued++;
    }
    return Results.Ok(new { queued });
}).RequireAuthorization();

// ── System: nuclear index rebuild ──────────────────────────────────────────────
// Wipe the disposable caches and rebuild them from the .md files (the authority).
// Broadcasts SystemRebuilding so clients can show a spinner while it runs.
// Run the nightly orphan sweep now: unreferenced media moves to the tenant's
// .trash (never a hard delete). Admin-only because the sweep spans every tenant.
app.MapPost("/api/system/prune-media", (OrphanPruneService prune) =>
    Results.Ok(new { moved = prune.PruneNow() }))
    .RequireAuthorization(p => p.RequireRole("Admin"))
    .WithTags("System")
    .WithSummary("Prune unreferenced media now (admin)")
    .WithDescription(
        "Moves media files that no live note references into the owning tenant's " +
        ".trash and reports how many moved. Same sweep the nightly background " +
        "service runs; nothing is deleted outright.");

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

// Serve an attachment back to the editor. The PapyraEditor adapter's
// resolveMediaUrl points ![[file]] embeds here. PathGuard jails the filename to
// the caller's own media dir, so one tenant can never read another's files.
app.MapGet("/api/media/{filename}", (
    string filename,
    ClaimsPrincipal user,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory) =>
{
    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, Uid(user));
    string dest;
    try
    {
        dest = PathGuard.ResolveAndVerify(mediaDir, filename, loggerFactory.CreateLogger("PathGuard"));
    }
    catch (SecurityException)
    {
        return Results.Forbid();
    }
    if (!File.Exists(dest)) return Results.NotFound();

    if (!new FileExtensionContentTypeProvider().TryGetContentType(dest, out var contentType))
        contentType = "application/octet-stream";
    return Results.File(dest, contentType, enableRangeProcessing: true);
})
.RequireAuthorization();

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

// Dashboard quick-import: drag one or more .md/.txt files onto the grid. Each becomes
// a new note immediately (synchronous, small files) — sanitized, titled from the
// first heading or filename, and written through the atomic markdown engine.
app.MapPost("/api/import/quick", async (
    HttpRequest request,
    ClaimsPrincipal user,
    VaultState state,
    MarkdownStorageService storage,
    WriteRing writeRing,
    SearchIndexService search,
    VaultObserverOptions vault,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a multipart upload." });
    var form = await request.ReadFormAsync(ct);
    if (form.Files.Count == 0) return Results.BadRequest(new { error = "No files." });

    var uid = Uid(user);
    var notesDir = vault.UserNotesDir(uid);
    Directory.CreateDirectory(notesDir);
    var guard = loggerFactory.CreateLogger("PathGuard");
    const long maxBytes = 2 * 1024 * 1024;

    var imported = new List<object>();
    // Skipping silently left the UI saying "Imported 0 notes" with no reason —
    // report what was dropped and why so the drop-zone can say so.
    var skipped = new List<object>();
    foreach (var file in form.Files)
    {
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext is not (".md" or ".txt"))
        { skipped.Add(new { file = file.FileName, reason = "Only .md and .txt files can be imported." }); continue; }
        if (file.Length == 0)
        { skipped.Add(new { file = file.FileName, reason = "File is empty." }); continue; }
        if (file.Length > maxBytes)
        { skipped.Add(new { file = file.FileName, reason = $"Larger than the {maxBytes / (1024 * 1024)} MB limit." }); continue; }

        string raw;
        using (var reader = new StreamReader(file.OpenReadStream()))
            raw = await reader.ReadToEndAsync(ct);

        var body = QuickImport.Sanitize(raw);
        var id = Guid.NewGuid().ToString();
        var note = new Note
        {
            Id = id,
            Title = QuickImport.TitleFrom(body, file.FileName),
            Body = body,
            Updated = DateTime.UtcNow,
        };

        var path = PathGuard.ResolveAndVerify(notesDir, $"{id}.md", guard);
        writeRing.Mark(path);
        await storage.WriteAsync(path, note, ct);
        state.Upsert(uid, path, note);
        search.IndexNote(uid, note);
        imported.Add(new { id, note.Title });
    }

    return Results.Ok(new { imported, skipped });
})
.RequireAuthorization()
.DisableAntiforgery();

app.MapGet("/api/export", (
    ClaimsPrincipal user,
    IConfiguration config,
    IHostEnvironment env) =>
{
    var notesDir = PapyraPaths.UserNotesDir(config, env.ContentRootPath, Uid(user));
    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, Uid(user));
    Directory.CreateDirectory(notesDir);

    var tmp = Path.Combine(Path.GetTempPath(), $"papyra-export-{Guid.NewGuid():N}.zip");
    using (var archive = ZipFile.Open(tmp, ZipArchiveMode.Create))
    {
        foreach (var file in Directory.EnumerateFiles(notesDir, "*", SearchOption.AllDirectories))
            archive.CreateEntryFromFile(file, Path.GetRelativePath(notesDir, file).Replace('\\', '/'));

        // Attachments too. Exporting notes without the images they embed leaves
        // every ![[file]] dangling the moment the archive is opened somewhere
        // else — the paths stay relative to `media/`, exactly as on disk.
        if (Directory.Exists(mediaDir))
        {
            foreach (var file in Directory.EnumerateFiles(mediaDir, "*", SearchOption.AllDirectories))
                archive.CreateEntryFromFile(
                    file, "media/" + Path.GetRelativePath(mediaDir, file).Replace('\\', '/'));
        }
    }

    // DeleteOnClose reclaims the temp zip once the response stream finishes.
    var stream = new FileStream(
        tmp, FileMode.Open, FileAccess.Read, FileShare.None, 4096, FileOptions.DeleteOnClose);
    return Results.File(stream, "application/zip", "papyra-export.zip");
})
.RequireAuthorization();

// ── Encrypted backups (cryptographic vaults) ────────────────────────────────
// AES-GCM, password-derived backups of the caller's own notes+media. The account
// password gates both directions. Generate streams a .papyra-vault file; restore
// decrypts into staging first (so a wrong password never touches the live vault),
// then swaps the vault contents in place and forces a per-tenant cache rebuild.
var backups = app.MapGroup("/api/backups").RequireAuthorization().WithTags("Backups");

backups.MapPost("/generate", async (
    BackupRequest body,
    ClaimsPrincipal principal,
    AppDbContext db,
    EncryptedBackupService backup,
    IConfiguration config,
    IHostEnvironment env,
    HttpContext http,
    CancellationToken ct) =>
{
    if (string.IsNullOrEmpty(body.Password))
        return Results.BadRequest(new { error = "Account password is required." });

    var uid = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([uid], ct);
    if (user is null) return Results.NotFound();
    if (!BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash))
        return Results.Json(new { error = "Password is incorrect." }, statusCode: StatusCodes.Status401Unauthorized);

    var root = env.ContentRootPath;
    var uidStr = uid.ToString();
    var sources = new[]
    {
        ("notes", PapyraPaths.UserNotesDir(config, root, uidStr)),
        ("media", PapyraPaths.UserMediaDir(config, root, uidStr)),
    };

    http.Response.ContentType = "application/octet-stream";
    http.Response.Headers.ContentDisposition = "attachment; filename=\"papyra-backup.papyra-vault\"";
    await backup.BackupAsync(sources, body.Password, http.Response.Body, ct);
    return Results.Empty;
})
    .WithSummary("Generate encrypted backup")
    .WithDescription("Verifies the account password, then streams an AES-GCM encrypted .papyra-vault of the caller's notes + media.");

backups.MapPost("/restore", async (
    HttpRequest request,
    ClaimsPrincipal principal,
    AppDbContext db,
    EncryptedBackupService backup,
    VaultState state,
    SearchIndexService search,
    MarkdownStorageService storage,
    VaultObserver observer,
    IHubContext<NotesHub> hub,
    IConfiguration config,
    IHostEnvironment env,
    CancellationToken ct) =>
{
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a multipart upload." });
    var form = await request.ReadFormAsync(ct);
    var password = form["password"].ToString();
    var file = form.Files["file"];
    if (string.IsNullOrEmpty(password) || file is null || file.Length == 0)
        return Results.BadRequest(new { error = "Password and backup file are required." });

    var uid = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([uid], ct);
    if (user is null) return Results.NotFound();
    if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
        return Results.Json(new { error = "Password is incorrect." }, statusCode: StatusCodes.Status401Unauthorized);

    var root = env.ContentRootPath;
    var uidStr = uid.ToString();
    var dotPapyra = PapyraPaths.UserDotPapyra(config, root, uidStr);
    Directory.CreateDirectory(dotPapyra);
    var staging = Path.Combine(dotPapyra, $"restore-{Guid.NewGuid():N}");

    try
    {
        // Decrypt + extract fully into staging first — a wrong password or corrupt
        // file fails here, before the live vault is touched.
        Directory.CreateDirectory(staging);
        await using (var upload = file.OpenReadStream())
        {
            try { await backup.RestoreAsync(upload, password, staging, ct); }
            catch (System.Security.Cryptography.CryptographicException)
            {
                return Results.Json(new { error = "Wrong password or corrupt backup." }, statusCode: StatusCodes.Status400BadRequest);
            }
            catch (InvalidDataException)
            {
                return Results.Json(new { error = "Not a valid Papyra backup file." }, statusCode: StatusCodes.Status400BadRequest);
            }
        }

        // In-place content swap: clearing/refilling the dirs (rather than moving them)
        // keeps the live FileSystemWatcher handle valid.
        var notesDir = PapyraPaths.UserNotesDir(config, root, uidStr);
        var mediaDir = PapyraPaths.UserMediaDir(config, root, uidStr);
        ReplaceDirContents(Path.Combine(staging, "notes"), notesDir);
        ReplaceDirContents(Path.Combine(staging, "media"), mediaDir);

        // Force a per-tenant cache rebuild from the restored .md files (the authority).
        // Stale notes removed by the restore fall out when the watcher fires their
        // deletes; this just makes the new set visible immediately.
        await hub.Clients.All.SendAsync("SystemRebuilding", ct);
        observer.WatchUser(uidStr); // ensures the dir exists + is watched (no-op if so)

        var scanned = new List<Note>();
        foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
        {
            if (ConflictDetector.IsConflict(Path.GetFileName(path))) continue;
            var note = await storage.ReadAsync(path, ct);
            if (note is null || string.IsNullOrEmpty(note.Id)) continue;
            state.Upsert(uidStr, path, note);
            scanned.Add(note);
        }
        search.RebuildUser(uidStr, scanned);

        return Results.Ok(new { restored = scanned.Count });
    }
    finally
    {
        if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
    }
})
    .DisableAntiforgery()
    .WithSummary("Restore from encrypted backup")
    .WithDescription("Decrypts an uploaded .papyra-vault (multipart: password + file) and replaces the caller's notes + media, then rebuilds the cache.");

app.MapHub<NotesHub>("/hubs/notes");

// An unmatched /api route must NOT fall through to the SPA: a client asking for
// `/api/shared/` (or any typo'd endpoint) was handed 200 text/html, so `res.ok`
// was true and the JSON parse blew up somewhere far from the cause. Answer in the
// shape the caller asked for.
app.MapFallback("/api/{**rest}", (HttpContext http) =>
    Results.Json(new { error = "No such endpoint.", path = http.Request.Path.Value }, statusCode: StatusCodes.Status404NotFound))
    .ExcludeFromDescription();

app.MapFallbackToFile("index.html");

app.Run();

// The authenticated tenant id, lifted from the NameIdentifier claim minted at
// sign-in. Every per-user storage path keys off this.
static string Uid(ClaimsPrincipal user) =>
    user.FindFirstValue(ClaimTypes.NameIdentifier)
    ?? throw new SecurityException("Authenticated principal carries no user id.");

// Hex SHA-256 — the at-rest form of an API token (lookup key on each request).
static string Sha256Hex(string input) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(input)));

// Resolve a note's .md path inside an arbitrary owner's vault (used by shares to
// reach across tenants — authorised by the Share row, jailed by PathGuard).
static string OwnerNotePath(VaultState state, VaultObserverOptions vault, ILoggerFactory lf, string ownerUid, string noteId) =>
    state.PathFor(ownerUid, noteId)
    ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(ownerUid), $"{noteId}.md", lf.CreateLogger("PathGuard"));

// Serve a media file from an arbitrary owner's vault (for shared notes). The
// caller's authorisation is established before this is reached (a valid link token
// or an incoming share row); PathGuard still jails the filename to that owner.
static IResult ServeOwnerMedia(
    string ownerUid, string filename, IConfiguration config, IHostEnvironment env, ILoggerFactory lf)
{
    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, ownerUid);
    string dest;
    try { dest = PathGuard.ResolveAndVerify(mediaDir, filename, lf.CreateLogger("PathGuard")); }
    catch (SecurityException) { return Results.Forbid(); }
    if (!File.Exists(dest)) return Results.NotFound();
    if (!new FileExtensionContentTypeProvider().TryGetContentType(dest, out var contentType))
        contentType = "application/octet-stream";
    return Results.File(dest, contentType, enableRangeProcessing: true);
}

// Apply a body-only edit to a note in the owner's vault on behalf of a sharee,
// keeping the caches + watchers consistent (mirrors the notes PUT write path).
static async Task<IResult> ApplySharedEdit(
    string ownerUid, string noteId, string newBody,
    VaultState state, MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    SnapshotService snapshots, IConfiguration config, IHostEnvironment env,
    IHubContext<NotesHub> hub, VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct)
{
    var path = OwnerNotePath(state, vault, lf, ownerUid, noteId);
    var note = await storage.ReadAsync(path, ct);
    if (note is null) return Results.NotFound();

    // Someone who is not the owner is about to replace the owner's text. Every
    // other write path snapshots the prior revision first; this one has to as
    // well, or a sharee (or an edit-link visitor) can erase the owner's writing
    // with nothing to recover from.
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, ownerUid);
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, noteId, lf.CreateLogger("PathGuard"));
    await snapshots.CaptureAsync(noteSnapDir, path, ct);

    note.Body = newBody;
    note.Updated = DateTime.UtcNow;
    writeRing.Mark(path);
    await storage.WriteAsync(path, note, ct);
    state.Upsert(ownerUid, path, note);
    search.IndexNote(ownerUid, note);
    await hub.Clients.All.SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
    return Results.NoContent();
}

// Replace targetDir's contents with sourceDir's, keeping targetDir itself (so a
// live FileSystemWatcher on it stays valid). Clears the target first, then mirrors
// the source tree in. A missing source tree just leaves the target empty.
static void ReplaceDirContents(string sourceDir, string targetDir)
{
    Directory.CreateDirectory(targetDir);
    foreach (var f in Directory.EnumerateFiles(targetDir, "*", SearchOption.AllDirectories)) File.Delete(f);
    foreach (var d in Directory.EnumerateDirectories(targetDir)) Directory.Delete(d, recursive: true);

    if (!Directory.Exists(sourceDir)) return;
    foreach (var dir in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
        Directory.CreateDirectory(Path.Combine(targetDir, Path.GetRelativePath(sourceDir, dir)));
    foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        File.Move(file, Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file)), overwrite: true);
}

// Withhold a secure note's body. Returns a COPY (never mutates the live vault
// object) with Body blanked, so `secure: true` notes travel as metadata only until
// the caller proves a biometric unlock. Non-secure notes pass through untouched.
static Note RedactSecure(Note note)
{
    if (!note.Secure) return note;
    return new Note
    {
        Id = note.Id,
        Title = note.Title,
        Tags = note.Tags,
        Color = note.Color,
        Pinned = note.Pinned,
        Archived = note.Archived,
        Kind = note.Kind,
        Trashed = note.Trashed,
        TrashedAt = note.TrashedAt,
        Secure = true,
        Body = string.Empty, // withheld — see /api/notes/{id}/secure
        Updated = note.Updated,
    };
}

// The JSON body delivered to webhooks for a note event.
static object WebhookPayload(string eventName, Note note) => new
{
    @event = eventName,
    noteId = note.Id,
    title = note.Title,
    tags = note.Tags,
    pinned = note.Pinned,
    occurredAt = note.Updated,
};

// A collision-free Username for a JIT-provisioned SSO account: prefer the email
// local-part, else a subject-derived handle, suffixing a counter if it's taken so
// the unique Username index never trips.
static async Task<string> UniqueSsoUsername(AppDbContext db, string email, string sub, CancellationToken ct)
{
    var baseName = email.Contains('@') ? email[..email.IndexOf('@')] : $"sso-{sub}";
    baseName = new string(baseName.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.').ToArray());
    if (string.IsNullOrWhiteSpace(baseName)) baseName = "sso-user";

    var candidate = baseName;
    var n = 1;
    while (await db.Users.AnyAsync(u => u.Username == candidate, ct))
        candidate = $"{baseName}-{++n}";
    return candidate;
}

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
    string? Body,
    string? Kind = null,
    // Nullable on purpose: omitted means "leave the existing lock state alone".
    bool? Secure = null);

// Manual ordering payload: the full desired map of note id → fractional sort key
// plus the note's mtime at drag time. Replaces the stored order wholesale.
public sealed record OrderWrite(List<OrderEntryDto>? Entries);
public sealed record OrderEntryDto(string Id, double Key, long SetAt);

// Category registry upsert: a curated tag name + optional colour.
public sealed record CategoryWrite(string? Name, string? Color);

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

// Self-service profile update (display name + email).
public sealed record ProfileRequest(string? Name, string? Email);

// Self-service password change: verify Current, set Next.
public sealed record PasswordRequest(string? Current, string? Next);

// API key creation payload (just a human label).
public sealed record ApiKeyWrite(string? Name);

// Webhook registration: which event, the target URL, and an optional shared secret
// (one is generated + returned once if omitted).
public sealed record WebhookWrite(string? Event, string? Url, string? Secret);

// Git-sync config. Token is write-only (null leaves the stored one untouched).
public sealed record GitConfigWrite(string? RemoteUrl, string? Branch, string? Token);

// Smart-collection creation: a display name + the serialized AND/OR rule set.
public sealed record SmartCollectionWrite(string? Name, string? RulesJson);

// WebAuthn enrolment: the browser's attestation response + a friendly device label.
public sealed record WebAuthnRegisterRequest(
    Fido2NetLib.AuthenticatorAttestationRawResponse? Response, string? Name);

// A question asked of the vault via retrieval-augmented chat.
public sealed record AiChatRequest(string? Question);

// WebAuthn unlock: the browser's assertion response.
public sealed record WebAuthnAssertRequest(Fido2NetLib.AuthenticatorAssertionRawResponse? Response);

// Encrypted-backup generation payload: the account password (verified, then reused
// as the vault encryption secret).
public sealed record BackupRequest(string? Password);

// OIDC SSO configuration (appsettings "Oidc"). SSO is enabled only when Authority
// and ClientId are both set; ClientSecret is needed for confidential clients.
public sealed class OidcSettings
{
    public string? Authority { get; set; }
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? DisplayName { get; set; }
}

// Share creation: kind (link|user) + access (view|edit). Link shares accept an
// optional expiry + max view count; user shares require a grantee username.
public sealed record ShareWrite(
    string? Kind, string? Access, string? GranteeUsername, DateTime? ExpiresUtc, int? MaxViews);

// Body-only edit payload for a shared note (sharees can't touch frontmatter).
public sealed record SharedBodyWrite(string? Body);

// Trash retention update: how many days a trashed note survives (-1/0/3/7/30/60).
public sealed record SettingsRequest(int TrashRetentionDays);

// Conflict resolution choice: "left" (keep parent), "right" (keep the copy),
// or "both" (promote the copy to a new note). The rejected .md is deleted either way.
public sealed record ResolveConflictRequest(
    string? Keep);

// Makes the implicit top-level Program class visible to WebApplicationFactory in integration tests.
public partial class Program { }
