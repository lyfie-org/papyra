using System.IO.Compression;
using System.Security;
using System.Security.Claims;
using System.Net;
using System.Net.Mail;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Papyra.Api.Collab;
using Papyra.Api.Data;
using Papyra.Api.Features;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Security;
using Papyra.Api.Storage;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// Accept plain-English environment variables (PAPYRA_ALLOW_INSECURE_COOKIES,
// PAPYRA_ALLOWED_ORIGINS, …) alongside .NET's own `Section__Key` spelling.
// Added last so it has the highest precedence among *providers*, but EnvAliases
// only emits keys whose friendly variable was actually set — so a deployment
// using the .NET names is unaffected. See EnvAliases for why this exists.
builder.Configuration.AddInMemoryCollection(EnvAliases.Resolve(EnvAliases.FromProcess()));

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
builder.Services.AddSingleton<BackupLayout>();

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
// Every background job reports here, so "what is Papyra doing when nobody is
// looking" has an answer that is not the server log.
builder.Services.AddSingleton<JobRegistry>();

builder.Services.AddHostedService<ColdBootDiffService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<VaultObserver>());
// Registered as a singleton as well as a hosted service so the housekeeping
// endpoint can run the same sweep on demand — a 24h timer is not something an
// admin (or a test) can wait for.
builder.Services.AddSingleton<OrphanPruneService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OrphanPruneService>());

// Permanently purges trashed notes once they outlive the retention window.
builder.Services.AddHostedService<TrashPurgeService>();
// Daily search rebuild — the safety net under live indexing (see SearchRebuildJob).
builder.Services.AddHostedService<SearchRebuildJob>();
// Readable file names for notes still stored under an id (see NoteFileNamingJob).
builder.Services.AddHostedService<NoteFileNamingJob>();
// Drops the unused ^block markers older versions stamped on every line.
builder.Services.AddHostedService<BlockAnchorCleanupJob>();
// Purges accounts a week after their owner asked, with daily reminders.
builder.Services.AddHostedService<AccountDeletionJob>();

// Hard-deletes expired / view-exhausted share links (burn-after-reading cleanup).
builder.Services.AddHostedService<ShareCleanupService>();

// Phase 15.2 housekeeping: drop block grants whose source note or anchor is gone.
builder.Services.AddHostedService<GrantCleanupService>();

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

// Phase 15.2: @mention → a block reference in the mentioned user's inbox.
builder.Services.AddSingleton<MentionDeliveryService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MentionDeliveryService>());

// Native git sync of the notes vault. Singleton so the manual-trigger endpoint runs
// the same instance as the background loop. Idle until a remote is configured.
builder.Services.AddSingleton<GitSyncService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<GitSyncService>());

// ── WebAuthn (biometric gatekeeper) ─────────────────────────────────────────────
// No fixed relying party: it is resolved per request from the address the app was
// opened on (Security/WebAuthnRelyingParty.cs). WebAuthn:ServerDomain optionally
// names a parent domain to share passkeys across subdomains; WebAuthn:Origins
// lists extra origins for a split front-end. Verification is Fido2NetLib's.
// The one door to every AI backend (Ollama / OpenAI / Anthropic). Timeouts are set
// per purpose because the jobs differ by orders of magnitude: a status probe must
// fail fast enough that the settings page never hangs on it, while a model pull is
// several gigabytes over whatever connection the self-hoster has.
builder.Services.AddHttpClient("ai-probe").ConfigureHttpClient(c => c.Timeout = TimeSpan.FromSeconds(3));
builder.Services.AddHttpClient("ai-embed").ConfigureHttpClient(c => c.Timeout = TimeSpan.FromSeconds(60));
builder.Services.AddHttpClient("ai-chat").ConfigureHttpClient(c => c.Timeout = TimeSpan.FromMinutes(5));
builder.Services.AddHttpClient("ai-pull").ConfigureHttpClient(c => c.Timeout = Timeout.InfiniteTimeSpan);
builder.Services.AddSingleton<AiClient>();

// The assistant is held back for a later release. Everything below stays wired
// up so it returns by flipping one setting, but with the feature off the routes
// 404 and nothing reaches out to a model. See Features/AiFeature.cs.
var aiEnabled = AiFeature.Enabled(builder.Configuration);

// Local semantic index: chunks + embeds notes into the SQLite vector cache.
// Singleton so the note-write endpoint enqueues onto the worker's instance.
// Constructed by hand rather than by DI so the feature switch can be passed in:
// with the assistant off the service accepts writes and drops them, which keeps
// the note-write path free of feature checks.
builder.Services.AddSingleton(sp => new EmbeddingService(
    sp.GetRequiredService<IServiceScopeFactory>(),
    sp.GetRequiredService<AiClient>(),
    sp.GetRequiredService<VaultState>(),
    sp.GetRequiredService<ILogger<EmbeddingService>>(),
    aiEnabled));
if (aiEnabled) builder.Services.AddHostedService(sp => sp.GetRequiredService<EmbeddingService>());

// Retrieval-augmented chat over the vault (configured LLM + the vector cache).
builder.Services.AddSingleton<RagChatService>();

// Pending challenges + unlock tokens outlive a request, so they're singletons; the
// service itself is scoped because IFido2 and the DbContext are.
builder.Services.AddSingleton<WebAuthnChallengeStore>();
builder.Services.AddSingleton<UnlockTokenStore>();
builder.Services.AddScoped<BiometricAuthService>();
builder.Services.AddScoped<VaultPinService>();
builder.Services.AddSingleton<TotpService>();

// Background import queue: drains uploaded Obsidian/Keep archives into the vault
// off the request thread, pushing progress over SignalR. Singleton so the endpoint
// can Enqueue onto the same instance the hosted worker drains.
builder.Services.AddSingleton<SearchRebuilder>();
builder.Services.AddSingleton<ExportTicketStore>();
builder.Services.AddSingleton<BlockAnchorCleanup>();
builder.Services.AddSingleton<AccountDeletion>();
builder.Services.AddSingleton<LinkPreviewService>();
builder.Services.AddSingleton<ImportService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ImportService>());

// Real-time push: the observer broadcasts metadata-only note events to clients.
builder.Services.AddSignalR();
// Live collaboration: the embedded engine (papyra.collab) runs as a child
// process of this API — see Collab/CollabHost.cs. Nothing to configure.
builder.Services.AddCollab(builder.Configuration);

// ── Cookie auth ──────────────────────────────────────────────────────────────
// Sessions ride a single HttpOnly cookie. SameSite=Strict + (in prod) Secure;
// sliding expiry keeps active users signed in. The SPA is same-origin in prod,
// so we never need to surface this cookie to JS. Unauthenticated API calls get a
// flat 401 (no login redirect) so the client router can route to /login itself.
// Optional OIDC SSO: enabled only when an Authority + ClientId are configured, so
// the default password-only deployment needs no IdP. SameSite must relax to Lax for
// the external redirect callback to carry the correlation cookie back.
// Seed values from appsettings/environment. These are only a *starting point*
// now: the live configuration lives in the database so an admin can set SSO up
// from the Settings UI, which is the only route available to someone running the
// published container. Anything found here is imported once, on first boot.
var oidcSeed = builder.Configuration.GetSection("Oidc").Get<OidcSettings>();

// Instance configuration (SSO, outbound mail) an admin edits from the UI.
builder.Services.AddSingleton<InstanceConfigStore>();

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

// Whether the session cookie may ride a plain-HTTP request.
//
// A `Secure` cookie is one a browser will only send back over a connection it
// considers trustworthy. `localhost` always counts, which is why this never
// shows up in local testing — but a self-hoster reaching the container at
// `http://100.64.22.10:11033` over a VPN does not, so Chrome silently discards
// the cookie at login and every subsequent request arrives anonymous. The
// symptom is "signing in appears to work, then every refresh signs me out",
// with no error anywhere to explain it.
//
// TLS remains the right answer for anything reachable from an untrusted
// network, so this stays off by default. It exists because a WireGuard/
// Tailscale tunnel already encrypts the transport, and demanding a certificate
// on top of that is a real cost with no attacker it defends against.
//
// SameAsRequest, not None: a deployment that later gains TLS goes straight back
// to marking the cookie Secure on HTTPS requests without touching this setting.
var allowInsecureCookies = builder.Configuration.GetValue("Papyra:AllowInsecureCookies", false);

var authBuilder = builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme);

authBuilder.AddCookie(options =>
    {
        options.Cookie.Name = "papyra.auth";
        options.Cookie.HttpOnly = true;
        // OIDC bounces the browser to the IdP and back; a Strict cookie wouldn't ride
        // the cross-site return, so relax to Lax when SSO is on (still not None).
        // Lax, not Strict. SSO is now configurable at runtime, so the cookie
        // policy can no longer be decided from startup config: an admin who
        // enables SSO under a Strict cookie would get a login loop, because the
        // correlation cookie is not sent on the IdP's top-level redirect back.
        // Lax still withholds the cookie from cross-site POST/PUT/DELETE, which
        // is every state-changing route Papyra has; Strict only added protection
        // for cross-site *navigation*, and Papyra's GETs are reads.
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = builder.Environment.IsDevelopment() || allowInsecureCookies
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

// Registered unconditionally. Authority/ClientId/ClientSecret come from the
// database via OidcOptionsConfigurator, so SSO can be configured (and
// reconfigured) from the admin UI without restarting the container. Whether the
// scheme is *usable* is a per-request check on the stored config — see
// `SsoConfigured()` — not a startup decision.
builder.Services.ConfigureOptions<OidcOptionsConfigurator>();
{
    authBuilder.AddOpenIdConnect("oidc", options =>
    {
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

                if (user.DisabledUtc is not null)
                {
                    // Back to the sign-in page with the reason, not an error page.
                    ctx.HandleResponse();
                    ctx.Response.Redirect("/login?disabled=1");
                    return;
                }
                await SignInNotices.RecordAsync(
                    ctx.HttpContext, db, sp.GetRequiredService<EmailSender>(), user, "Single sign-on", ctx.HttpContext.RequestAborted);

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

builder.Services.AddSingleton<LoginThrottle>();
// Outbound mail. Singleton like the config it reads; every send is best-effort.
builder.Services.AddSingleton<EmailSender>();

const string UserSearchRateLimit = "user-search";
const string AuthRateLimit = "auth";
const string PreviewRateLimit = "previews";

// The mention typeahead is the one endpoint on which any tenant can ask about
// accounts other than their own, so it gets a per-account budget: comfortably
// more than a person types, far less than a cheap walk of the user table. Keyed
// on the caller's user id (falling back to the remote address for an unauthenticated
// request, which 401s anyway) so one noisy account can't spend everyone's budget.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(UserSearchRateLimit, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            ctx.User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? ctx.Connection.RemoteIpAddress?.ToString()
                ?? "anonymous",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromSeconds(10),
                QueueLimit = 0, // shed instead of queueing: a stale suggestion is useless
            }));

    // Credential endpoints, keyed on the caller's address — the blunt half of the
    // brute-force defence, and the half a reverse proxy weakens: without
    // Papyra:TrustedProxies every request arrives from the proxy's address and
    // shares one bucket, as do all users behind a single NAT.
    //
    // That shared bucket is why this ceiling is loose. LoginThrottle is the
    // control that actually caps guessing (10 per account per 15 min) and it is
    // immune to network shape; this only exists to blunt a naive flood. Tuned
    // down to 20/min it was measurably harmful — one attacker spent the budget
    // and a bystander on the same address was refused a correct password until
    // the window rolled over.
    options.AddPolicy(AuthRateLimit, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));

    // Link previews: per account, generous enough for a desk full of links
    // (cached server-side, so repeats are free), and apart from the sign-in
    // bucket so browsing notes can never lock anyone out of logging in.
    options.AddPolicy(PreviewRateLimit, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 120,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
});

// Behind a reverse proxy every request otherwise arrives from the proxy's address,
// which collapses the IP-keyed limiter into one shared bucket and puts the proxy
// in the access logs instead of the client. Opt-in only: trusting X-Forwarded-For
// from an untrusted network would let a caller forge its own address, so this
// stays off until a self-hoster names the proxies.
var trustedProxies = builder.Configuration.GetSection("Papyra:TrustedProxies").Get<string[]>() ?? [];
if (trustedProxies.Length > 0)
{
    builder.Services.Configure<ForwardedHeadersOptions>(options =>
    {
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
        options.KnownProxies.Clear();
        options.KnownNetworks.Clear();
        foreach (var proxy in trustedProxies)
            if (System.Net.IPAddress.TryParse(proxy, out var ip)) options.KnownProxies.Add(ip);
    });
}

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

// Say it out loud. This weakens a real defence, and the person who set it six
// months ago should be able to find out why their cookies are not Secure by
// reading the boot log rather than the source.
if (allowInsecureCookies && !app.Environment.IsDevelopment())
{
    app.Logger.LogWarning(
        "Papyra:AllowInsecureCookies is ON: the session cookie is sent over plain HTTP. " +
        "Only safe when the transport is already private (a WireGuard/Tailscale tunnel, " +
        "or a host-only network). Anything reachable from an untrusted network needs TLS.");
}

// Run migrations on boot so papyra.db materializes before ports open.
using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.Migrate();
}

// Warm the instance config before the first request: the OIDC options
// configurator resolves synchronously inside the auth stack and cannot await.
{
    var instanceConfig = app.Services.GetRequiredService<InstanceConfigStore>();
    await instanceConfig.EnsureLoadedAsync();

    // One-time import of SSO settings that used to live in appsettings/env. An
    // existing deployment keeps working after upgrading without the admin having
    // to re-enter anything; from then on the database is the authority, so the
    // import never overwrites what they later change in the UI.
    if (!instanceConfig.Has(OidcKeys.Authority)
        && !string.IsNullOrWhiteSpace(oidcSeed?.Authority)
        && !string.IsNullOrWhiteSpace(oidcSeed.ClientId))
    {
        await instanceConfig.SetAsync(new Dictionary<string, string?>
        {
            [OidcKeys.Enabled] = "true",
            [OidcKeys.Authority] = oidcSeed.Authority,
            [OidcKeys.ClientId] = oidcSeed.ClientId,
            [OidcKeys.ClientSecret] = oidcSeed.ClientSecret,
            [OidcKeys.DisplayName] = oidcSeed.DisplayName ?? string.Empty,
        });
        app.Logger.LogInformation("Imported SSO configuration from appsettings into the database");
    }
}

// One-time move of git sync from an instance-wide setting to a per-account one.
//
// The old config initialised a single repository over the *users* directory, so
// whoever set a remote was pushing every tenant's notes to it. Git sync is now
// per account and scoped to that account's own vault. The existing settings are
// handed to the first admin — the person who almost certainly entered them — so
// their backup keeps running, and the legacy keys are removed so the old
// instance-wide path can never be revived by a stale row.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    var legacy = await db.Settings.Where(s => GitKeys.LegacyKeys.Contains(s.Key)).ToListAsync();
    if (legacy.Count > 0)
    {
        var owner = await db.Users
            .Where(u => u.Role == "Admin")
            .OrderBy(u => u.Id)
            .Select(u => u.Id)
            .FirstOrDefaultAsync();

        if (owner != 0)
        {
            var uid = owner.ToString();
            foreach (var row in legacy)
            {
                var suffix = row.Key["git.".Length..];
                var moved = GitKeys.Prefix(uid) + suffix;
                if (await db.Settings.FindAsync(moved) is null && !string.IsNullOrWhiteSpace(row.Value))
                    db.Settings.Add(new AppSetting { Key = moved, Value = row.Value });
            }
            app.Logger.LogWarning(
                "Git sync was instance-wide and pushed every user's notes. Moved that configuration "
                + "to admin user {User}; it now backs up only their own vault. Other users can set "
                + "up their own backup in Settings.", uid);
        }

        db.Settings.RemoveRange(legacy);
        await db.SaveChangesAsync();
    }
}

// First in the pipeline so everything downstream — the rate limiter's partition
// key, the access log, the HTTPS check below — sees the real client rather than
// the proxy. No-op unless Papyra:TrustedProxies named one.
if (trustedProxies.Length > 0) app.UseForwardedHeaders();

// ── Response hardening ────────────────────────────────────────────────────────
// Papyra serves its own SPA, so these apply to the whole origin. The CSP's
// script-src carries the hash of whatever inline script actually shipped in
// wwwroot/index.html (the anti-flash theme bootstrap), read once at startup.
var indexHtmlPath = Path.Combine(app.Environment.WebRootPath ?? "wwwroot", "index.html");
var appCsp = SecurityHeaders.AppPolicy(
    File.Exists(indexHtmlPath)
        ? SecurityHeaders.InlineScriptHashes(File.ReadAllText(indexHtmlPath))
        : []);
var docsCsp = SecurityHeaders.DocsPolicy();

app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "DENY";              // legacy peer of frame-ancestors
    headers["Referrer-Policy"] = "no-referrer";
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    // Recording audio for transcription is a first-party feature; nothing else is.
    headers["Permissions-Policy"] = "camera=(), geolocation=(), microphone=(self)";

    // Only meaningful over TLS, and only outside Development, where a stray HSTS
    // header would pin localhost to https for months.
    if (context.Request.IsHttps && !app.Environment.IsDevelopment())
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";

    headers["Content-Security-Policy"] =
        context.Request.Path.StartsWithSegments("/docs")
        || context.Request.Path.StartsWithSegments("/openapi")
            ? docsCsp
            : appCsp;

    await next();
});

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

// The services that are simply always on. They have no timer and nothing to
// trigger, but leaving them off the Jobs screen would suggest Papyra does less
// in the background than it does.
{
    var jobs = app.Services.GetRequiredService<JobRegistry>();
    jobs.RegisterContinuous("vault-watcher", "Watch your notes folder",
        "Notices when a note changes on disk — edited by another app, restored from a backup, "
        + "or synced in — and brings it into Papyra without you doing anything.");
    jobs.RegisterContinuous("mention-delivery", "Deliver mentions",
        "When someone names you in a note, this puts a notice in your inbox and emails you if you asked it to.");
    jobs.RegisterContinuous("search-index", "Keep search up to date",
        "Re-reads a note the moment it changes so searching finds what you wrote a second ago.");
    jobs.RegisterContinuous("webhooks", "Send webhooks",
        "Passes changes on to anything you have connected to Papyra, retrying if it can't be reached.");

    // A housekeeping job that starts failing is the admins' business.
    var scopes = app.Services.GetRequiredService<IServiceScopeFactory>();
    var mailer = app.Services.GetRequiredService<EmailSender>();
    jobs.OnFailure = async (job, error) =>
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var admin in await db.Users.Where(u => u.Role == "Admin" && u.DisabledUtc == null).ToListAsync())
            await mailer.NotifyAsync(admin, NotificationCatalog.AdminJobFailed,
                $"“{job.Name}” failed on your Papyra",
                $"The background job “{job.Name}” failed. It will try again on its next run; you'll hear again only "
                + "if it fails after working.\n\nSee Settings → Jobs in Papyra for details, or run it again from there.",
                [new("Job", job.Name), new("Error", error.Length > 300 ? error[..300] + "…" : error)]);
    };
}

app.UseAuthentication();

// ── Development sign-in bypass ────────────────────────────────────────────────
// Treats a loopback request as an already-signed-in user, so a local browser
// session (or an automated UI run) reaches the app without going through the
// login form. Development convenience only: it hands out a session with no
// credential, which is exactly the thing the rest of this file exists to prevent.
//
// Three locks, all of which must be open:
//   1. the environment is Development,
//   2. `Papyra:DevSignInAs` names a user — absent, the middleware is never even
//      added to the pipeline, so there is nothing to misfire in production,
//   3. the request came from loopback, so a Development build accidentally
//      exposed to a network still refuses remote callers.
//
// `DevSignInBypassTests` asserts locks 1 and 2 hold. A null RemoteIpAddress is
// accepted because the in-process TestServer has no socket to report — a real
// Kestrel connection always has an address.
var devSignInAs = app.Configuration["Papyra:DevSignInAs"];
if (app.Environment.IsDevelopment() && !string.IsNullOrWhiteSpace(devSignInAs))
{
    app.Logger.LogWarning(
        "Development sign-in bypass ACTIVE: loopback requests are treated as '{User}' with no password. " +
        "Papyra:DevSignInAs must never be set outside local development.", devSignInAs);

    app.Use(async (context, next) =>
    {
        var remote = context.Connection.RemoteIpAddress;
        if (context.User.Identity?.IsAuthenticated != true && (remote is null || IPAddress.IsLoopback(remote)))
        {
            var db = context.RequestServices.GetRequiredService<AppDbContext>();
            var user = await db.Users.FirstOrDefaultAsync(
                u => u.Username == devSignInAs, context.RequestAborted);
            if (user is not null)
            {
                // Same claim shape as SignInAsync: UserId as NameIdentifier, so the
                // per-tenant path jail scopes this session like any other.
                context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
                    new Claim(ClaimTypes.Name, user.Username),
                    new Claim(ClaimTypes.Role, user.Role),
                ], "DevSignIn"));
            }
        }
        await next();
    });
}

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

// ── Account standing: disabled, role, forced password change, deletion ───────
// Read from the database on every authenticated request rather than trusted from
// the cookie, so an administrator's decision takes effect on sessions that are
// already open — not at their next sign-in, up to a week later.
//
//   • Disabled: nothing gets through, API keys and the live-update socket
//     included, and the cookie is cleared so the browser lands on the sign-in page.
//   • Role: the claim is replaced with the current one, so a demoted admin loses
//     the admin routes on their very next request (and a promotion needs no
//     sign-out either).
//   • MustChangePassword: an account an admin provisioned (or reset) can only see
//     who it is, set a new password, and sign out. A flag the client could ignore
//     would be decoration, so the refusal lives here.
//   • Deletion scheduled: the account can only cancel.
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    if (context.User.Identity?.IsAuthenticated == true
        && (path.StartsWithSegments("/api") || path.StartsWithSegments("/hubs"))
        && int.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out var callerId))
    {
        var db = context.RequestServices.GetRequiredService<AppDbContext>();
        var flags = await db.Users
            .Where(u => u.Id == callerId)
            .Select(u => new { u.MustChangePassword, u.DeletionScheduledUtc, u.DisabledUtc, u.Role })
            .FirstOrDefaultAsync(context.RequestAborted);

        if (flags?.DisabledUtc is not null && !path.StartsWithSegments("/api/auth/logout"))
        {
            if (context.User.Identity.AuthenticationType == CookieAuthenticationDefaults.AuthenticationScheme)
                await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            context.RequestServices.GetRequiredService<UnlockTokenStore>().RevokeUser(callerId.ToString());
            await Results.Json(
                new { error = "This account has been disabled. Ask your Papyra administrator.", code = "account_disabled" },
                statusCode: StatusCodes.Status401Unauthorized).ExecuteAsync(context);
            return;
        }

        if (flags is not null && context.User.FindFirstValue(ClaimTypes.Role) != flags.Role
            && context.User.Identity is ClaimsIdentity current)
        {
            var identity = new ClaimsIdentity(
                current.Claims.Where(c => c.Type != ClaimTypes.Role).Append(new Claim(ClaimTypes.Role, flags.Role)),
                current.AuthenticationType);
            context.User = new ClaimsPrincipal(identity);
        }

        var exempt = path.StartsWithSegments("/hubs")
            || path.StartsWithSegments("/api/auth/me")
            || path.StartsWithSegments("/api/auth/password")
            || path.StartsWithSegments("/api/auth/logout");
        if (!exempt && flags is not null)
        {
            // An account on its way out can do one thing: cancel.
            if (flags.DeletionScheduledUtc is not null && !path.StartsWithSegments("/api/account/delete"))
            {
                await Results.Json(
                    new { error = "This account is scheduled for deletion.", code = "deletion_scheduled" },
                    statusCode: StatusCodes.Status403Forbidden).ExecuteAsync(context);
                return;
            }
            if (flags.MustChangePassword)
            {
                await Results.Json(
                    new { error = "Choose your own password before you carry on.", code = "password_change_required" },
                    statusCode: StatusCodes.Status403Forbidden).ExecuteAsync(context);
                return;
            }
        }
    }
    await next();
});

app.UseAuthorization();

// After authentication, so a limiter partition can key on the caller's id rather
// than on a shared proxy address. Only endpoints that opt in are affected.
app.UseRateLimiter();

// ── SSO reachability backstop ─────────────────────────────────────────────────
// A challenge fetches the IdP's discovery document, so an authority that is
// wrong, unreachable, or not an OIDC provider throws from inside the handler.
// An admin now types that URL into a form, which makes misconfiguration an
// expected failure — and it has to read as one. An unhandled 500 says nothing
// about what to fix.
app.Use(async (context, next) =>
{
    var isSsoPath = context.Request.Path.StartsWithSegments("/api/auth/login/sso")
        || context.Request.Path.StartsWithSegments("/signin-oidc");
    if (!isSsoPath)
    {
        await next();
        return;
    }

    try
    {
        await next();
    }
    // The transport failure arrives buried: the handler throws
    // InvalidOperationException (IDX20803) wrapping an IOException (IDX20804)
    // wrapping the actual HttpRequestException, so only walking the whole chain
    // recognises it.
    catch (Exception ex) when (IsNetworkFailure(ex))
    {
        app.Logger.LogWarning(ex, "SSO sign-in failed — the configured authority was unreachable");
        // Anything already streamed can't be replaced with a clean error.
        if (context.Response.HasStarted) throw;
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        await context.Response.WriteAsJsonAsync(new
        {
            error = "Couldn't reach the identity provider. Check the Authority URL in Settings → SSO.",
        });
    }
});

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
app.MapGet("/health", (ICollabEngine collab) => Results.Ok(new
    {
        status = "Healthy",
        app = "Papyra API",
        // ok | starting | degraded | disabled — degraded never makes the app
        // unhealthy: notes just use the classic editor.
        collab = collab.Status.ToString().ToLowerInvariant(),
    }))
    .ExcludeFromDescription();

// ── Auth: first-admin setup ──────────────────────────────────────────────────
// One-shot bootstrap. Only succeeds while the user table is empty; the created
// account is always the admin. Login/logout + cookie sessions land in Sprint 6.2.
var auth = app.MapGroup("/api/auth").WithTags("Auth");

// A BCrypt hash no password will ever match, used to spend the same work on a
// login for an account that doesn't exist as on one that does. Computed once.
var DummyPasswordHash = BCrypt.Net.BCrypt.HashPassword(Guid.NewGuid().ToString("N"));

// ── First-run setup (guided) ─────────────────────────────────────────────────
// Every /setup route answers only while the instance has no accounts: the first
// person to reach a fresh Papyra is, by definition, the one setting it up — the
// rule POST /setup always had. Once the admin exists they all answer 409.
//
// The flow the SPA walks: (optionally) stage a backup to restore → username →
// email + a code sent to it (configuring outbound mail first if needed) →
// password → vault PIN → time zone → POST /setup, which creates the admin, sets
// the PIN and applies the staged backup in one go. Import and theme follow,
// signed in, through the ordinary endpoints.
auth.MapGet("/setup/status", async (AppDbContext db, EmailSender email, InstanceConfigStore config, CancellationToken ct) =>
{
    await config.EnsureLoadedAsync(ct);
    return Results.Ok(new
    {
        needsSetup = !await db.Users.AnyAsync(ct),
        emailConfigured = email.IsConfigured,
        serverTimeZone = ServerTimeZoneId(),
    });
});

// Outbound mail, so the verification code has a way out. Same validation as the
// admin form; saving here switches mail on.
auth.MapPut("/setup/smtp", async (SmtpConfigWrite body, AppDbContext db, InstanceConfigStore config, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    var (values, problem) = SmtpValues(body with { Enabled = true });
    if (problem is not null) return Results.BadRequest(new { error = problem });
    await config.SetAsync(values!, ct);
    return Results.NoContent();
}).RequireRateLimiting(AuthRateLimit);

auth.MapPost("/setup/email/code", async (
    SetupEmailCodeRequest body, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    var address = body.Email?.Trim() ?? string.Empty;
    if (!ProfileRules.IsEmail(address))
        return Results.BadRequest(new { error = "That doesn’t look like an email address.", field = "email" });
    if (!email.IsConfigured)
        return Results.BadRequest(new { error = "Papyra can't send email yet. Set up outgoing mail first.", code = "email_not_configured" });

    var code = System.Security.Cryptography.RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
    db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.Kind == "setup-email"));
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = SetupCodeHash(address, code),
        Kind = "setup-email",
        Email = address,
        ExpiresUtc = DateTime.UtcNow.AddMinutes(15),
    });
    await db.SaveChangesAsync(ct);

    var sent = await email.SendAsync(address, $"{code} is your Papyra setup code",
        $"You're setting up a new Papyra. Enter this code to confirm your email address:\n\n{code}\n\n"
        + "It works for 15 minutes. If you aren't setting up Papyra, ignore this email.",
        [new EmailDetail("Code", code)], ct);
    return sent.Sent
        ? Results.Ok(new { sentTo = address })
        : Results.BadRequest(new { error = $"The code couldn't be emailed: {sent.Error}", code = "send_failed" });
}).RequireRateLimiting(AuthRateLimit);

// Check a code without spending it, so the wizard can move on with confidence;
// POST /setup spends it.
auth.MapPost("/setup/email/verify", async (SetupEmailVerifyRequest body, AppDbContext db, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    return await LiveSetupCodeAsync(db, body.Email, body.Code, ct) is null
        ? Results.BadRequest(new { error = "That code is wrong or has expired.", field = "emailCode" })
        : Results.Ok(new { ok = true });
}).RequireRateLimiting(AuthRateLimit);

// The first admin's authenticator. A fresh Papyra usually has no outgoing mail,
// so an emailed code can't be the account's proof of identity; an authenticator
// app needs nothing from the server but a clock. The secret travels back with
// POST /setup (there is no account to keep it on yet) and is only stored once a
// code from it has been checked.
auth.MapPost("/setup/totp", async (SetupTotpRequest body, AppDbContext db, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    var secret = Totp.NewSecret();
    var account = string.IsNullOrWhiteSpace(body.Account) ? "admin" : body.Account.Trim();
    return Results.Ok(new { secret, uri = Totp.ProvisioningUri(secret, account) });
}).RequireRateLimiting(AuthRateLimit);

// A matching code is remembered for the rest of the wizard: by the time POST
// /setup runs, minutes later, the code typed here has long rolled over.
auth.MapPost("/setup/totp/verify", async (TotpVerifyRequest body, AppDbContext db, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    var secret = body.Secret?.Trim() ?? string.Empty;
    if (Totp.Match(secret, body.Code, DateTimeOffset.UtcNow) is null)
        return Results.BadRequest(new { error = "That code didn’t match. Check the time on your phone and try the newest code.", field = "totpCode" });
    db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.Kind == "setup-totp"));
    db.AuthTokens.Add(new AuthToken { TokenHash = SetupTotpHash(secret), Kind = "setup-totp", ExpiresUtc = DateTime.UtcNow.AddHours(1) });
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(AuthRateLimit);

// Stage a backup to restore into the account about to be created: decrypt and
// unpack it now (so a wrong password is caught before anything else), report
// what it holds and the preferences it carries, and keep it until POST /setup.
// Multipart: kind=file (file + password) or kind=git (remoteUrl, branch, token,
// password when the repository is encrypted).
auth.MapPost("/setup/restore", async (
    HttpRequest request, AppDbContext db, EncryptedBackupService backup, GitSyncService git,
    IConfiguration config, IHostEnvironment env, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a multipart upload." });
    var form = await request.ReadFormAsync(ct);
    var kind = form["kind"].ToString();
    var password = form["password"].ToString();

    // One staged restore at a time: starting another replaces it.
    var stagingRoot = SetupStagingRoot(config, env);
    if (Directory.Exists(stagingRoot)) DeleteDirectoryForce(stagingRoot);
    var id = Guid.NewGuid().ToString("N");
    var dir = Path.Combine(stagingRoot, id);
    var plain = Path.Combine(dir, "plain");
    Directory.CreateDirectory(dir);

    try
    {
        SetupRestoreMeta meta;
        if (kind == "file")
        {
            var file = form.Files["file"];
            if (file is null || file.Length == 0 || string.IsNullOrEmpty(password))
                return Results.BadRequest(new { error = "Choose the backup file and enter the password it was made with." });
            Directory.CreateDirectory(plain);
            await using var upload = file.OpenReadStream();
            try { await backup.RestoreAsync(upload, password, plain, ct); }
            catch (System.Security.Cryptography.CryptographicException)
            { return Results.BadRequest(new { error = "Wrong password, or the file is damaged.", code = "password_wrong" }); }
            catch (InvalidDataException)
            { return Results.BadRequest(new { error = "That isn't a Papyra backup file (.papyra-vault)." }); }
            meta = new SetupRestoreMeta(null, null, null, null, null, null);
        }
        else if (kind == "git")
        {
            var remote = form["remoteUrl"].ToString().Trim();
            if (!Uri.TryCreate(remote, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
                return Results.BadRequest(new { error = "Paste the repository's https address, e.g. https://github.com/you/papyra-notes.git" });
            var branch = string.IsNullOrWhiteSpace(form["branch"]) ? "main" : form["branch"].ToString().Trim();
            var token = form["token"].ToString().Trim();
            var staged = await StageGitBackupAsync(remote, branch, token, password, plain, git, ct);
            if (staged.Error is not null) return Results.BadRequest(new { error = staged.Error, code = staged.Code });
            meta = new SetupRestoreMeta(remote, branch, token, staged.Source!.Mode, staged.Source.SealedKey, staged.Source.HeaderJson);
        }
        else return Results.BadRequest(new { error = "Restore from a file or a git repository." });

        await File.WriteAllTextAsync(Path.Combine(dir, "meta.json"), System.Text.Json.JsonSerializer.Serialize(meta), ct);
        return Results.Ok(new { restoreId = id, summary = BackupLayout.Summarize(plain) });
    }
    catch
    {
        DeleteDirectoryForce(dir);
        throw;
    }
    finally
    {
        // A failed attempt leaves nothing staged.
        if (!File.Exists(Path.Combine(dir, "meta.json")) && Directory.Exists(dir)) DeleteDirectoryForce(dir);
    }
}).DisableAntiforgery().RequireRateLimiting(AuthRateLimit);

auth.MapPost("/setup", async (
    SetupRequest body, HttpContext http, AppDbContext db, VaultObserver observer, EmailSender email,
    VaultPinService pins, TotpService totp, BackupLayout layout, GitSyncService git, VaultState state, MarkdownStorageService storage,
    SearchIndexService search, IHubContext<NotesHub> hub, IConfiguration config, IHostEnvironment env, CancellationToken ct) =>
{
    if (await db.Users.AnyAsync(ct))
        return Results.Conflict(new { error = "Already initialized." });

    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Username and password are required." });
    var username = body.Username.Trim();
    if (ProfileRules.UsernameProblem(username) is { } badName)
        return Results.BadRequest(new { error = badName, field = "username" });

    if (PasswordPolicy.Validate(body.Password) is { } setupWeak)
        return Results.BadRequest(new { error = setupWeak, field = "password" });

    // An address is confirmed with the code sent to it whenever this Papyra can
    // send mail. Without mail there is nothing to confirm it with, and it is
    // kept as typed.
    var address = body.Email?.Trim() ?? string.Empty;
    AuthToken? emailToken = null;
    if (address.Length > 0)
    {
        if (!ProfileRules.IsEmail(address))
            return Results.BadRequest(new { error = "That doesn’t look like an email address.", field = "email" });
        if (email.IsConfigured)
        {
            emailToken = await LiveSetupCodeAsync(db, address, body.EmailCode, ct);
            if (emailToken is null)
                return Results.BadRequest(new { error = "Confirm your email with the code we sent to it.", field = "emailCode" });
        }
    }

    // An authenticator is compulsory for the first admin: it is the account's
    // proof of identity before anything sensitive (a fresh Papyra usually has no
    // mail to send a code with). Proven either by a code now or by
    // /setup/totp/verify earlier in the wizard.
    if (string.IsNullOrWhiteSpace(body.TotpSecret))
        return Results.BadRequest(new { error = "Set up an authenticator app first.", field = "totpCode" });
    var totpSecret = body.TotpSecret.Trim();
    AuthToken? totpProof = null;
    var totpStep = Totp.Match(totpSecret, body.TotpCode, DateTimeOffset.UtcNow);
    if (totpStep is null)
    {
        var hash = SetupTotpHash(totpSecret);
        totpProof = await db.AuthTokens.FirstOrDefaultAsync(t => t.Kind == "setup-totp" && t.TokenHash == hash, ct);
        if (totpProof is null || totpProof.UsedUtc is not null || totpProof.ExpiresUtc < DateTime.UtcNow)
            return Results.BadRequest(new { error = "That authenticator code didn’t match. Try the newest one.", field = "totpCode" });
        // Nothing typed now to spend: refuse this step's code from here on.
        totpStep = Totp.StepAt(DateTimeOffset.UtcNow);
    }

    if (body.Pin is { Length: > 0 } && VaultPin.Validate(body.Pin) is { } badPin)
        return Results.BadRequest(new { error = badPin, field = "pin" });
    var zone = body.TimeZone?.Trim();
    if (!string.IsNullOrEmpty(zone) && !TimeZoneInfo.TryFindSystemTimeZoneById(zone, out _))
        return Results.BadRequest(new { error = "That isn’t a time zone this server recognises.", field = "timeZone" });
    if (body.Theme is not (null or "light" or "dark" or "system"))
        return Results.BadRequest(new { error = "Theme is light, dark or system.", field = "theme" });

    // A staged restore is addressed by the id /setup/restore handed out — a GUID,
    // parsed as one so it can never name a path.
    string? restoreDir = null;
    if (!string.IsNullOrEmpty(body.RestoreId))
    {
        if (!Guid.TryParseExact(body.RestoreId, "N", out _)
            || !File.Exists(Path.Combine(SetupStagingRoot(config, env), body.RestoreId, "meta.json")))
            return Results.BadRequest(new { error = "The backup you chose is no longer staged. Choose it again.", field = "restore" });
        restoreDir = Path.Combine(SetupStagingRoot(config, env), body.RestoreId);
    }

    var user = new User
    {
        Username = username,
        Name = string.IsNullOrWhiteSpace(body.Name) ? username : body.Name.Trim(),
        Email = address,
        PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password),
        PasswordChangedUtc = DateTime.UtcNow,
        Role = "Admin",
        TimeZone = string.IsNullOrEmpty(zone) ? null : zone,
        Theme = body.Theme,
    };
    totp.Enable(user, totpSecret, totpStep.Value);

    db.Users.Add(user);
    if (emailToken is not null) emailToken.UsedUtc = DateTime.UtcNow;
    if (totpProof is not null) totpProof.UsedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);

    observer.WatchUser(user.Id.ToString()); // create + watch the new tenant's vault
    if (body.Pin is { Length: > 0 }) await pins.SetAsync(user, body.Pin, ct);

    var restored = 0;
    if (restoreDir is not null)
    {
        try
        {
            await layout.ApplyAsync(Path.Combine(restoreDir, "plain"), user, db, restoreProfile: true, ct);
            // What was just chosen in the wizard beats what the backup remembered.
            if (!string.IsNullOrEmpty(zone)) user.TimeZone = zone;
            if (body.Theme is not null) user.Theme = body.Theme;
            if (!string.IsNullOrWhiteSpace(body.Name)) user.Name = body.Name.Trim();
            await db.SaveChangesAsync(ct);
            restored = await RescanUserAsync(user.Id.ToString(), config, env, state, storage, search, observer, hub, ct);

            var meta = System.Text.Json.JsonSerializer.Deserialize<SetupRestoreMeta>(
                await File.ReadAllTextAsync(Path.Combine(restoreDir, "meta.json"), ct));
            if (meta?.RemoteUrl is { Length: > 0 })
                await SaveGitBackupConfigAsync(db, git, user.Id.ToString(), meta.RemoteUrl, meta.Branch ?? "main", meta.Token,
                    new GitRestoreSource(meta.Mode ?? "plain", meta.SealedKey, meta.HeaderJson), body.Password, config, env, ct);
        }
        finally
        {
            DeleteDirectoryForce(restoreDir);
        }
    }

    await SignInAsync(http, user); // the first admin starts signed in
    return Results.Ok(new
    {
        user.Id, user.Username, user.Name, user.Email, user.Role, user.TimeZone, user.Theme,
        serverTimeZone = ServerTimeZoneId(), restored,
    });
}).RequireRateLimiting(AuthRateLimit);

// Validate credentials against the BCrypt hash and mint the session cookie. Same
// generic 401 for unknown user and bad password so we don't leak which one failed.
auth.MapPost("/login", async (
    LoginRequest body, HttpContext http, AppDbContext db, LoginThrottle throttle, EmailSender email, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.BadRequest(new { error = "Username and password are required." });

    if (throttle.IsLockedOut(body.Username))
        return Results.Json(
            new { error = "Too many failed attempts. Try again later." },
            statusCode: StatusCodes.Status429TooManyRequests);

    var user = await db.Users.FirstOrDefaultAsync(u => u.Username == body.Username.Trim(), ct);

    // Verify against a throwaway hash when the account doesn't exist, so a miss
    // costs the same BCrypt work as a wrong password. Skipping it would make
    // "no such user" measurably faster than "wrong password" and turn this
    // endpoint into a username oracle.
    bool ok;
    if (user is null)
    {
        BCrypt.Net.BCrypt.Verify(body.Password, DummyPasswordHash);
        ok = false;
    }
    else
    {
        ok = BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash);
    }

    if (!ok)
    {
        throttle.RecordFailure(body.Username);
        return Results.Json(new { error = "Invalid credentials." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    throttle.Reset(body.Username);
    // Only after the password checks out, so "disabled" is never a free answer
    // to "does this account exist".
    if (user!.DisabledUtc is not null) return AccountDisabled();
    await SignInAsync(http, user);
    await SignInNotices.RecordAsync(http, db, email, user, "Password", ct);
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role, user.TimeZone, user.Theme, serverTimeZone = ServerTimeZoneId() });
}).RequireRateLimiting(AuthRateLimit);

// ── Sign in with a passkey ──────────────────────────────────────────────────────
// The biometric devices registered under Settings → Security also sign in, from
// the address they were registered on. Two steps: options for the named account
// (always answered, so it never reveals whether the account exists or has a
// passkey), then the signed assertion. Failures count against the same lockout
// as wrong passwords.
auth.MapPost("/passkey/options", async (
    PasskeyOptionsRequest body, HttpRequest request, IConfiguration config, AppDbContext db,
    BiometricAuthService bio, LoginThrottle throttle, CancellationToken ct) =>
{
    var username = body.Username?.Trim() ?? string.Empty;
    if (username.Length == 0) return Results.BadRequest(new { error = "Enter your username first." });
    if (throttle.IsLockedOut(username))
        return Results.Json(new { error = "Too many failed attempts. Try again later." },
            statusCode: StatusCodes.Status429TooManyRequests);
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });
    var user = await db.Users.FirstOrDefaultAsync(u => u.Username == username, ct);
    return Results.Text((await bio.LoginChallengeAsync(user, party, ct)).ToJson(), "application/json");
}).RequireRateLimiting(AuthRateLimit);

auth.MapPost("/passkey/verify", async (
    PasskeyVerifyRequest body, HttpContext http, IConfiguration config, AppDbContext db,
    BiometricAuthService bio, LoginThrottle throttle, EmailSender email, CancellationToken ct) =>
{
    var username = body.Username?.Trim() ?? string.Empty;
    if (username.Length == 0 || body.Response is null)
        return Results.BadRequest(new { error = "Missing passkey response." });
    if (throttle.IsLockedOut(username))
        return Results.Json(new { error = "Too many failed attempts. Try again later." },
            statusCode: StatusCodes.Status429TooManyRequests);
    var (party, problem) = WebAuthnRelyingParty.Resolve(http.Request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });

    var user = await db.Users.FirstOrDefaultAsync(u => u.Username == username, ct);
    if (user is null || !await bio.LoginVerifyAsync(user.Id, body.Response, party, ct))
    {
        throttle.RecordFailure(username);
        return Results.Json(new { error = "That passkey didn't work. Try again, or use your password." },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    throttle.Reset(username);
    if (user.DisabledUtc is not null) return AccountDisabled();
    await SignInAsync(http, user);
    await SignInNotices.RecordAsync(http, db, email, user, "Passkey", ct);
    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role, user.TimeZone, user.Theme, serverTimeZone = ServerTimeZoneId() });
}).RequireRateLimiting(AuthRateLimit);

auth.MapPost("/logout", async (HttpContext http, UnlockTokenStore unlockTokens) =>
{
    // An open vault closes with the session.
    if (http.User.FindFirstValue(ClaimTypes.NameIdentifier) is { } uid) unlockTokens.RevokeUser(uid);
    await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.NoContent();
});

// ── SSO (OIDC) ────────────────────────────────────────────────────────────────
// Anonymous. `providers` tells the login screen whether an SSO button belongs
// there; `login/sso` kicks off the OIDC challenge (→ IdP → /signin-oidc callback →
// cookie session via OnTokenValidated → back to the app).
auth.MapGet("/providers", async (InstanceConfigStore config, CancellationToken ct) =>
{
    await config.EnsureLoadedAsync(ct);
    var name = config.GetOrEmpty(OidcKeys.DisplayName);
    return Results.Ok(new
    {
        sso = SsoConfigured(config),
        ssoName = string.IsNullOrWhiteSpace(name) ? "SSO" : name,
    });
});

auth.MapGet("/login/sso", async (InstanceConfigStore config, CancellationToken ct) =>
{
    await config.EnsureLoadedAsync(ct);
    if (!SsoConfigured(config)) return Results.NotFound(new { error = "SSO is not configured." });
    return Results.Challenge(new AuthenticationProperties { RedirectUri = "/" }, ["oidc"]);
});


// ── Password reset + invitation redemption (anonymous) ────────────────────────
// Rate-limited with the other credential routes. Three rules hold throughout:
//   • the response never reveals whether an account exists (no enumeration),
//   • only the SHA-256 of a token is stored, so a database read cannot mint one,
//   • redemption is single-use and marks the row before the password changes.
auth.MapPost("/forgot-password", async (
    ForgotPasswordRequest body, AppDbContext db, EmailSender email,
    HttpContext http, CancellationToken ct) =>
{
    var identifier = body.UsernameOrEmail?.Trim() ?? string.Empty;

    // Always the same answer, whatever happens next. "No such account" here is a
    // free membership oracle for anyone with a list of addresses.
    var vague = Results.Ok(new
    {
        message = "If that account exists and has an email address, a reset link is on its way.",
    });
    if (identifier.Length == 0 || !email.IsConfigured) return vague;

    var user = await db.Users.FirstOrDefaultAsync(
        u => u.Username == identifier || u.Email == identifier, ct);
    if (user is null || string.IsNullOrWhiteSpace(user.Email) || user.DisabledUtc is not null) return vague;

    var (token, hash) = NewAuthToken();
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = hash,
        Kind = "reset",
        UserId = user.Id,
        Email = user.Email,
        Username = user.Username,
        // Short window: a reset link sitting in an inbox is a standing key to
        // the account.
        ExpiresUtc = DateTime.UtcNow.AddHours(1),
    });
    await db.SaveChangesAsync(ct);

    var link = $"{email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}")}/reset-password?token={token}";
    await email.NotifyAsync(
        user, NotificationCatalog.PasswordReset,
        "Reset your Papyra password",
        $"Someone asked to reset the password for \"{user.Username}\".\n\n"
        + $"Set a new one here:\n{link}\n\n"
        + "This link expires in 1 hour and can be used once. "
        + "If this wasn't you, ignore this email — nothing has changed.",
        ct: ct);

    return vague;
})
    .RequireRateLimiting(AuthRateLimit)
    .WithSummary("Request a password reset link");

// Shared by both flows: report what a token is for without consuming it, so the
// SPA can render the right form (or a clean "link expired" page).
auth.MapGet("/token/{token}", async (string token, AppDbContext db, CancellationToken ct) =>
{
    var row = await FindLiveToken(db, token, ct);
    return row is null
        ? Results.NotFound(new { error = "This link is invalid or has expired." })
        : Results.Ok(new { kind = row.Kind, username = row.Username, email = row.Email });
})
    .RequireRateLimiting(AuthRateLimit);

auth.MapPost("/reset-password", async (
    ResetPasswordRequest body, AppDbContext db, EmailSender email, GitSyncService git, CancellationToken ct) =>
{
    if (PasswordPolicy.Validate(body.Password) is { } weak)
        return Results.BadRequest(new { error = weak });

    var row = await FindLiveToken(db, body.Token ?? string.Empty, ct);
    if (row is null || row.Kind != "reset" || row.UserId is null)
        return Results.BadRequest(new { error = "This link is invalid or has expired." });

    var user = await db.Users.FindAsync([row.UserId.Value], ct);
    if (user is null) return Results.BadRequest(new { error = "This link is invalid or has expired." });
    if (user.DisabledUtc is not null) return AccountDisabled();

    user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password!);
    user.PasswordChangedUtc = DateTime.UtcNow;
    user.MustChangePassword = false; // they chose this one themselves
    row.UsedUtc = DateTime.UtcNow;   // burn it in the same transaction as the change
    await RewrapGitBackupKeyAsync(db, git, user.Id.ToString(), body.Password!, ct);
    await db.SaveChangesAsync(ct);

    // Security mail, sent regardless of notification preferences: being told your
    // password changed is how you find out it wasn't you who changed it.
    await email.NotifyAsync(
        user, NotificationCatalog.PasswordChanged,
        "Your Papyra password was changed",
        $"The password for \"{user.Username}\" was just reset.\n\n"
        + "If that wasn't you, contact your Papyra administrator immediately.",
        [new("When", SignInNotices.When(user, DateTime.UtcNow))], ct);

    return Results.NoContent();
})
    .RequireRateLimiting(AuthRateLimit)
    .WithSummary("Set a new password from a reset link");

auth.MapPost("/accept-invite", async (
    ResetPasswordRequest body, AppDbContext db, VaultObserver observer, CancellationToken ct) =>
{
    if (PasswordPolicy.Validate(body.Password) is { } weak)
        return Results.BadRequest(new { error = weak });

    var row = await FindLiveToken(db, body.Token ?? string.Empty, ct);
    if (row is null || row.Kind != "invite")
        return Results.BadRequest(new { error = "This invitation is invalid or has expired." });

    // The username was reserved when the invite was sent, not taken — someone
    // else may have claimed it in the meantime.
    if (await db.Users.AnyAsync(u => u.Username == row.Username, ct))
        return Results.Conflict(new { error = "That username has been taken since the invitation was sent." });

    var user = new User
    {
        Username = row.Username,
        Name = row.Username,
        Email = row.Email,
        PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Password!),
        PasswordChangedUtc = DateTime.UtcNow,
        Role = row.Role == "Admin" ? "Admin" : "User",
    };
    db.Users.Add(user);
    row.UsedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);

    observer.WatchUser(user.Id.ToString()); // create + watch the new tenant's vault
    return Results.Ok(new { user.Username });
})
    .RequireRateLimiting(AuthRateLimit)
    .WithSummary("Redeem an invitation and create the account");

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

    return Results.Ok(new
    {
        user.Id, user.Username, user.Name, user.Email, user.Role,
        // The SPA routes to the change-password screen on this rather than on a
        // 403, so a freshly provisioned user lands there instead of watching
        // every request on the page fail.
        user.MustChangePassword,
        // Set while the account waits out its deletion week — the app shows the
        // "keep my account" screen instead of the desk.
        deletionScheduledUtc = user.DeletionScheduledUtc is { } due ? DateTime.SpecifyKind(due, DateTimeKind.Utc) : (DateTime?)null,
        // Times are shown in the person's chosen zone, else the server's (the
        // container's TZ) — the client falls back from one to the other.
        user.TimeZone,
        serverTimeZone = ServerTimeZoneId(),
        // The theme follows the person, not the browser: every sign-in opens in it.
        user.Theme,
        totpEnabled = TotpService.IsEnabled(user),
    });
});

// ── Vault: PIN (required) + biometrics (optional) ─────────────────────────────
// Secure notes open with a short-lived unlock token (UnlockTokenStore). There are
// two ways to earn one: the vault PIN, which every vault must have, and a
// registered platform authenticator, which is an extra convenience on devices
// that support it. Neither route accepts an API key: a key is for scripts, and a
// script that can unlock the vault is a stolen key away from reading it.
var vault = auth.MapGroup("/vault").RequireAuthorization().WithTags("Vault")
    .AddEndpointFilter(async (ctx, next) =>
        IsApiKey(ctx.HttpContext.User)
            ? Results.Json(new { error = "The vault cannot be opened with an API key.", code = "session_required" },
                statusCode: StatusCodes.Status403Forbidden)
            : await next(ctx));

vault.MapGet("/", async (
    ClaimsPrincipal principal, HttpRequest request, AppDbContext db, IConfiguration config, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([uid], ct);
    if (user is null) return Results.NotFound();
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    var credentials = await db.WebAuthnCredentials.Where(c => c.UserId == uid).ToListAsync(ct);
    var now = DateTime.UtcNow;
    return Results.Ok(new
    {
        pinSet = !string.IsNullOrEmpty(user.VaultPinHash),
        pinDisabled = VaultPin.IsHardLocked(user.VaultPinFailures),
        // SQLite hands DateTime back unmarked; say it is UTC, or the browser reads
        // the lockout as local time and shows it as already over.
        lockedUntilUtc = user.VaultPinLockedUntilUtc > now
            ? DateTime.SpecifyKind(user.VaultPinLockedUntilUtc.Value, DateTimeKind.Utc)
            : (DateTime?)null,
        attemptsLeft = VaultPin.AttemptsLeft(user.VaultPinFailures),
        pinLength = new { min = VaultPin.MinLength, max = VaultPin.MaxLength },
        hasPassword = !string.IsNullOrEmpty(user.PasswordHash),
        biometric = new
        {
            available = party is not null,
            problem,
            rpId = party?.RpId,
            // Credentials this address can use (a passkey belongs to one host).
            usableHere = party is null ? 0 : credentials.Count(c => c.RpId.Length == 0 || c.RpId == party.RpId),
            registered = credentials.Count,
        },
    });
});

// Set or change the PIN. Needs proof it is the owner, not just someone holding the
// session: the current PIN, the account password (the "forgot PIN" route), or a
// live unlock (e.g. a biometric one). The single exception is an account with no
// local password (SSO) setting its first PIN while it has nothing locked yet.
vault.MapPost("/pin", async (
    VaultPinSetRequest body, ClaimsPrincipal principal, HttpRequest request, AppDbContext db,
    VaultState state, VaultPinService pins, UnlockTokenStore unlockTokens, LoginThrottle throttle,
    CancellationToken ct) =>
{
    if (VaultPin.Validate(body.Pin) is { } invalid) return Results.BadRequest(new { error = invalid, code = "pin_invalid" });

    var uid = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([uid], ct);
    if (user is null) return Results.NotFound();
    var pinSet = !string.IsNullOrEmpty(user.VaultPinHash);

    var authorised = unlockTokens.IsValid(request.Headers["X-Unlock-Token"].ToString(), uid.ToString());
    if (!authorised && !string.IsNullOrEmpty(body.Password))
    {
        if (string.IsNullOrEmpty(user.PasswordHash))
            return Results.BadRequest(new { error = "This account signs in with SSO and has no password.", code = "no_password" });
        if (throttle.IsLockedOut(user.Username))
            return Results.Json(new { error = "Too many wrong passwords. Try again later.", code = "password_locked" },
                statusCode: StatusCodes.Status429TooManyRequests);
        if (!BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash))
        {
            throttle.RecordFailure(user.Username);
            return Results.Json(new { error = "Password is incorrect.", code = "password_wrong" },
                statusCode: StatusCodes.Status401Unauthorized);
        }
        throttle.Reset(user.Username);
        authorised = true;
    }
    if (!authorised && pinSet && body.CurrentPin is not null)
    {
        var verdict = await pins.CheckAsync(uid, body.CurrentPin, ct);
        if (verdict.Result != PinCheck.Ok) return PinFailure(verdict);
        authorised = true;
    }
    if (!authorised && !pinSet && string.IsNullOrEmpty(user.PasswordHash)
        && !state.Snapshot(uid.ToString()).Any(n => n.Secure))
        authorised = true;

    if (!authorised)
        return Results.Json(new
        {
            error = pinSet ? "Enter your current PIN or your account password." : "Confirm with your account password.",
            code = "proof_required",
        }, statusCode: StatusCodes.Status401Unauthorized);

    await pins.SetAsync(user, body.Pin!, ct);
    // Setting the PIN proves possession, so hand back an unlock for this session.
    return Results.Ok(new { unlockToken = unlockTokens.Issue(uid.ToString()) });
}).RequireRateLimiting(AuthRateLimit);

vault.MapPost("/unlock", async (
    VaultUnlockRequest body, ClaimsPrincipal principal, VaultPinService pins, UnlockTokenStore unlockTokens,
    CancellationToken ct) =>
{
    var uid = Uid(principal);
    var verdict = await pins.CheckAsync(int.Parse(uid), body.Pin, ct);
    return verdict.Result == PinCheck.Ok
        ? Results.Ok(new { unlockToken = unlockTokens.Issue(uid) })
        : PinFailure(verdict);
}).RequireRateLimiting(AuthRateLimit);

// Close the vault on this session now (the lock button), rather than waiting for
// the unlock to expire.
// Sliding expiry: the client calls this while someone is actively reading or
// editing locked notes, so the vault doesn't shut mid-read. An idle vault still
// closes five minutes after the last touch. Needs the live token itself — a
// session alone can never re-open or extend anything.
vault.MapPost("/keepalive", (ClaimsPrincipal principal, HttpRequest request, UnlockTokenStore unlockTokens) =>
    unlockTokens.Touch(request.Headers["X-Unlock-Token"].ToString(), Uid(principal))
        ? Results.NoContent()
        : Results.Json(new { error = "Unlock the vault first.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized));

vault.MapPost("/lock", (ClaimsPrincipal principal, UnlockTokenStore unlockTokens) =>
{
    unlockTokens.RevokeUser(Uid(principal));
    return Results.NoContent();
});

// ── WebAuthn (optional biometric unlock) ─────────────────────────────────────
// Enrolling or removing an authenticator needs the vault PIN to exist and a live
// unlock: otherwise anyone holding a session could enrol their own fingerprint
// and walk straight past the PIN. Verification is delegated to Fido2NetLib;
// challenges are single-use, expiring, and bound to the address they were issued on.
var webauthn = auth.MapGroup("/webauthn").RequireAuthorization().WithTags("Vault")
    .AddEndpointFilter(async (ctx, next) =>
        IsApiKey(ctx.HttpContext.User)
            ? Results.Json(new { error = "The vault cannot be opened with an API key.", code = "session_required" },
                statusCode: StatusCodes.Status403Forbidden)
            : await next(ctx));

webauthn.MapGet("/credentials", async (ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(principal));
    return Results.Ok(await db.WebAuthnCredentials
        .Where(c => c.UserId == uid)
        .Select(c => new { c.Id, c.Name, c.CreatedUtc, c.LastUsedUtc, c.RpId })
        .ToListAsync(ct));
});

webauthn.MapPost("/register/challenge", async (
    ClaimsPrincipal principal, HttpRequest request, AppDbContext db, IConfiguration config,
    BiometricAuthService bio, UnlockTokenStore unlockTokens, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    if (VaultGuard(user, request, unlockTokens) is { } refused) return refused;
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });
    return Results.Text((await bio.RegisterChallengeAsync(user, party, ct)).ToJson(), "application/json");
});

webauthn.MapPost("/register/verify", async (
    WebAuthnRegisterRequest body, ClaimsPrincipal principal, HttpRequest request, AppDbContext db,
    IConfiguration config, BiometricAuthService bio, UnlockTokenStore unlockTokens, EmailSender email,
    HttpContext http, CancellationToken ct) =>
{
    if (body.Response is null) return Results.BadRequest(new { error = "Missing attestation response." });
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    if (VaultGuard(user, request, unlockTokens) is { } refused) return refused;
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });
    try
    {
        var error = await bio.RegisterVerifyAsync(user, body.Response, body.Name, party, ct);
        if (error is not null) return Results.BadRequest(new { error });
        await email.NotifyAsync(user, NotificationCatalog.PasskeyAdded,
            "A passkey was added to your Papyra account",
            "A device was registered to sign in to your account and open your vault with biometrics.\n\n"
            + "If that wasn't you, remove it under Settings → Security and change your password.",
            [new("Device name", string.IsNullOrWhiteSpace(body.Name) ? "(unnamed)" : body.Name.Trim()),
             new("Works at", party.RpId), .. RequestDetails(user, http)], ct);
        return Results.Ok(new { registered = true });
    }
    catch (Fido2NetLib.Fido2VerificationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

webauthn.MapPost("/challenge", async (
    ClaimsPrincipal principal, HttpRequest request, IConfiguration config, BiometricAuthService bio,
    CancellationToken ct) =>
{
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });
    var options = await bio.AssertChallengeAsync(int.Parse(Uid(principal)), party, ct);
    return options is null
        ? Results.BadRequest(new { error = "No authenticator registered for this address.", code = "no_credential" })
        : Results.Text(options.ToJson(), "application/json");
}).RequireRateLimiting(AuthRateLimit);

webauthn.MapPost("/verify", async (
    WebAuthnAssertRequest body, ClaimsPrincipal principal, HttpRequest request, IConfiguration config,
    BiometricAuthService bio, CancellationToken ct) =>
{
    if (body.Response is null) return Results.BadRequest(new { error = "Missing assertion response." });
    var (party, problem) = WebAuthnRelyingParty.Resolve(request, config);
    if (party is null) return Results.BadRequest(new { error = problem!.Message, code = problem.Code });
    var token = await bio.AssertVerifyAsync(int.Parse(Uid(principal)), body.Response, party, ct);
    // A failed assertion never explains why — don't help an attacker probe.
    return token is null
        ? Results.Json(new { error = "Verification failed." }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Ok(new { unlockToken = token });
}).RequireRateLimiting(AuthRateLimit);

webauthn.MapDelete("/credentials/{id:int}", async (
    int id, ClaimsPrincipal principal, HttpRequest request, AppDbContext db, UnlockTokenStore unlockTokens,
    EmailSender email, HttpContext http, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([uid], ct);
    if (user is null) return Results.NotFound();
    if (VaultGuard(user, request, unlockTokens) is { } refused) return refused;
    var credential = await db.WebAuthnCredentials.FirstOrDefaultAsync(c => c.Id == id && c.UserId == uid, ct);
    if (credential is null) return Results.NotFound();
    db.WebAuthnCredentials.Remove(credential);
    await db.SaveChangesAsync(ct);
    await email.NotifyAsync(user, NotificationCatalog.PasskeyRemoved,
        "A passkey was removed from your Papyra account",
        "A registered device can no longer sign in to your account or open your vault.",
        [new("Device name", credential.Name), .. RequestDetails(user, http)], ct);
    return Results.NoContent();
});

// ── Profile (self-service) ──────────────────────────────────────────────────────
// The signed-in user edits their own display name + email, changes their password,
// and uploads an avatar. Avatar lives under the user's hidden .papyra dir (UI
// state, not the notes vault).
auth.MapPut("/profile", async (
    ProfileRequest body, HttpContext http, ClaimsPrincipal principal, AppDbContext db, EmailSender mail,
    LoginThrottle throttle, TotpService totp, CancellationToken ct) =>
{
    var id = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    // Username: optional in the payload (older clients never send it). Renaming
    // is safe because everything a user owns is keyed by their numeric id — the
    // vault dir, shares, keys, the avatar — and the avatar-by-username lookup
    // reads the live row. What does not follow a rename is text: an `@oldname`
    // already typed into someone's note stays as written.
    var renamed = false;
    var previousEmail = user.Email;
    if (body.Username is not null)
    {
        var wanted = body.Username.Trim();
        if (ProfileRules.UsernameProblem(wanted) is { } bad)
            return Results.BadRequest(new { error = bad, field = "username" });
        if (!string.Equals(wanted, user.Username, StringComparison.Ordinal))
        {
            // Case-insensitive: "Bea" and "bea" as two accounts would make every
            // @mention and every sign-in ambiguous.
            var lower = wanted.ToLower();
            if (await db.Users.AnyAsync(u => u.Id != id && u.Username.ToLower() == lower, ct))
                return Results.Conflict(new { error = "That username is taken.", field = "username" });
            user.Username = wanted;
            renamed = true;
        }
    }

    if (body.Name is not null)
    {
        var name = body.Name.Trim();
        if (name.Length > ProfileRules.MaxNameLength)
            return Results.BadRequest(new { error = $"Keep the name under {ProfileRules.MaxNameLength} characters.", field = "name" });
        // Blank means "no display name": fall back to the username, as setup does.
        user.Name = name.Length == 0 ? user.Username : name;
    }

    if (body.Email is not null)
    {
        var email = body.Email.Trim();
        if (email.Length > 0)
        {
            if (!ProfileRules.IsEmail(email))
                return Results.BadRequest(new { error = "That doesn’t look like an email address.", field = "email" });
            // Password reset finds an account by email; two accounts sharing one
            // would hand the reset link for one to the owner of the other.
            var lower = email.ToLower();
            if (await db.Users.AnyAsync(u => u.Id != id && u.Email.ToLower() == lower, ct))
                return Results.Conflict(new { error = "Another account already uses that email.", field = "email" });
        }

        // Moving the account to another address is how a stolen session becomes
        // a stolen account: every reset link would follow it. So the change needs
        // proof: the authenticator app's code, or a code sent to the address it is
        // leaving, or — with neither available — the account password.
        if (!string.Equals(email, user.Email, StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(user.Email))
        {
            var key = $"email-change:{user.Id}";
            if (throttle.IsLockedOut(key))
                return Results.Json(new { error = "Too many attempts. Try again later.", field = "emailCode" }, statusCode: 429);
            if (!string.IsNullOrWhiteSpace(body.TotpCode))
            {
                if (!totp.Verify(user, body.TotpCode))
                {
                    throttle.RecordFailure(key);
                    return Results.BadRequest(new { error = "That authenticator code didn’t match. Try the newest one.", field = "totpCode" });
                }
            }
            else if (TotpService.IsEnabled(user) && string.IsNullOrWhiteSpace(body.EmailCode))
            {
                return Results.Json(new { error = "Enter the code from your authenticator app.", field = "totpCode", code = "totp_required" },
                    statusCode: StatusCodes.Status428PreconditionRequired);
            }
            else if (mail.IsConfigured)
            {
                var code = body.EmailCode?.Trim() ?? string.Empty;
                if (code.Length == 0)
                    return Results.Json(new { error = "Enter the code we emailed to your current address.", field = "emailCode", code = "email_code_required" },
                        statusCode: StatusCodes.Status428PreconditionRequired);
                var hash = EmailChangeCodeHash(user.Id, email, code);
                var token = await db.AuthTokens.FirstOrDefaultAsync(t => t.UserId == user.Id && t.Kind == "email-change" && t.TokenHash == hash, ct);
                if (token is null || token.UsedUtc is not null || token.ExpiresUtc < DateTime.UtcNow)
                {
                    throttle.RecordFailure(key);
                    return Results.BadRequest(new { error = "That code is wrong or has expired. Send a new one.", field = "emailCode" });
                }
                token.UsedUtc = DateTime.UtcNow;
            }
            else if (string.IsNullOrEmpty(body.CurrentPassword) || !BCrypt.Net.BCrypt.Verify(body.CurrentPassword, user.PasswordHash))
            {
                if (!string.IsNullOrEmpty(body.CurrentPassword)) throttle.RecordFailure(key);
                return Results.Json(new { error = "Confirm with your account password to change your email.", field = "currentPassword", code = "password_required" },
                    statusCode: StatusCodes.Status428PreconditionRequired);
            }
            throttle.Reset(key);
        }
        user.Email = email;
    }

    if (body.Theme is not null)
    {
        if (body.Theme is not ("light" or "dark" or "system"))
            return Results.BadRequest(new { error = "Theme is light, dark or system.", field = "theme" });
        user.Theme = body.Theme;
    }

    // Empty = "use the server's zone"; anything else must be a zone this machine
    // knows, or every timestamp the person reads would quietly fall back to UTC.
    if (body.TimeZone is not null)
    {
        var tz = body.TimeZone.Trim();
        if (tz.Length > 0 && !TimeZoneInfo.TryFindSystemTimeZoneById(tz, out _))
            return Results.BadRequest(new { error = "That isn’t a time zone this server recognises.", field = "timeZone" });
        user.TimeZone = tz.Length == 0 ? null : tz;
    }

    await db.SaveChangesAsync(ct);

    // The session cookie carries the username as a claim; re-issue it so the new
    // name is what the rest of this session sees. Only for a cookie session — an
    // API-key request has no cookie to replace.
    if (renamed && principal.Identity?.AuthenticationType == CookieAuthenticationDefaults.AuthenticationScheme)
        await SignInAsync(http, user);

    // To the address being replaced: it's the one an attacker who took the
    // session would want to stop hearing from Papyra.
    if (!string.IsNullOrWhiteSpace(previousEmail)
        && !string.Equals(previousEmail, user.Email, StringComparison.OrdinalIgnoreCase))
        await mail.NotifyAsync(user, previousEmail, NotificationCatalog.EmailChanged,
            "The email on your Papyra account changed",
            $"The email address on \"{user.Username}\" was changed, so Papyra will write to the new one from now on.\n\n"
            + "If that wasn't you, sign in and change your password, then put your address back under Settings → Profile.",
            [new("New address", string.IsNullOrWhiteSpace(user.Email) ? "(none)" : user.Email), .. RequestDetails(user, http)], ct);

    return Results.Ok(new { user.Id, user.Username, user.Name, user.Email, user.Role, user.TimeZone, user.Theme, serverTimeZone = ServerTimeZoneId() });
}).RequireAuthorization();

// Step one of changing your email: a six-digit code to the address you have now,
// bound to the address you are moving to. PUT /profile spends it.
auth.MapPost("/email/code", async (
    EmailCodeRequest body, ClaimsPrincipal principal, HttpContext http, AppDbContext db, EmailSender mail, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    var wanted = body.Email?.Trim() ?? string.Empty;
    if (!ProfileRules.IsEmail(wanted))
        return Results.BadRequest(new { error = "That doesn’t look like an email address.", field = "email" });
    if (string.Equals(wanted, user.Email, StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "That is already your email.", field = "email" });
    var lower = wanted.ToLower();
    if (await db.Users.AnyAsync(u => u.Id != user.Id && u.Email.ToLower() == lower, ct))
        return Results.Conflict(new { error = "Another account already uses that email.", field = "email" });
    if (string.IsNullOrWhiteSpace(user.Email)) return Results.Ok(new { required = false });
    var canEmail = mail.IsConfigured;
    // An authenticator is the first choice: nothing has to be delivered. Email is
    // the fallback, on request, when this Papyra can send it.
    if (TotpService.IsEnabled(user) && !(body.ViaEmail && canEmail))
        return Results.Ok(new { required = true, method = "totp", canEmail });
    if (!canEmail) return Results.Ok(new { required = false, passwordRequired = true });

    var code = System.Security.Cryptography.RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
    db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.UserId == user.Id && t.Kind == "email-change"));
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = EmailChangeCodeHash(user.Id, wanted, code),
        Kind = "email-change",
        UserId = user.Id,
        Email = wanted,
        Username = user.Username,
        ExpiresUtc = DateTime.UtcNow.AddMinutes(10),
    });
    await db.SaveChangesAsync(ct);

    var sent = await mail.SendAsync(user.Email, $"{code} is your code to change your Papyra email",
        $"Someone — hopefully you — asked to move the Papyra account @{user.Username} to a new email address.\n\n"
        + $"Your code is {code}. It works once, for 10 minutes.\n\n"
        + "If this wasn't you, don't share the code: change your password now. Your email stays as it is.",
        [new EmailDetail("Code", code), new EmailDetail("New address", wanted), .. RequestDetails(user, http)], ct);
    return sent.Sent
        ? Results.Ok(new { required = true, method = "email", sentTo = MaskEmail(user.Email), totp = TotpService.IsEnabled(user) })
        : Results.BadRequest(new { error = "The code couldn't be emailed. Try again shortly." });
}).RequireAuthorization().RequireRateLimiting(AuthRateLimit);

// ── Authenticator app (TOTP) ──────────────────────────────────────────────────
// The first way to confirm a sensitive action; an emailed code is the second.
// Setting one up, replacing it or removing it asks for the account password, and
// is only for a signed-in person — never an API key.
auth.MapGet("/totp", async (ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    return Results.Ok(new
    {
        enabled = TotpService.IsEnabled(user),
        enabledUtc = user.TotpEnabledUtc is { } at ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : (DateTime?)null,
    });
}).RequireAuthorization();

// A fresh secret to scan. Nothing is stored until POST /totp proves it with a code.
auth.MapPost("/totp/begin", async (ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    if (IsApiKey(principal)) return Results.Json(new { error = "Use the app, not an API key." }, statusCode: 403);
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    var secret = Totp.NewSecret();
    return Results.Ok(new { secret, uri = Totp.ProvisioningUri(secret, user.Username) });
}).RequireAuthorization().RequireRateLimiting(AuthRateLimit);

auth.MapPost("/totp", async (
    TotpEnableRequest body, ClaimsPrincipal principal, HttpContext http, AppDbContext db, TotpService totp,
    EmailSender mail, LoginThrottle throttle, CancellationToken ct) =>
{
    if (IsApiKey(principal)) return Results.Json(new { error = "Use the app, not an API key." }, statusCode: 403);
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    var key = $"totp:{user.Id}";
    if (throttle.IsLockedOut(key)) return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: 429);
    if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash))
    {
        throttle.RecordFailure(key);
        return Results.Json(new { error = "That password isn't right.", field = "password" }, statusCode: 401);
    }
    var secret = body.Secret?.Trim() ?? string.Empty;
    if (Totp.Match(secret, body.Code, DateTimeOffset.UtcNow) is not { } step)
    {
        throttle.RecordFailure(key);
        return Results.BadRequest(new { error = "That code didn’t match. Check the time on your phone and try the newest code.", field = "totpCode" });
    }
    var replaced = TotpService.IsEnabled(user);
    totp.Enable(user, secret, step);
    await db.SaveChangesAsync(ct);
    throttle.Reset(key);
    await mail.NotifyAsync(user, NotificationCatalog.TotpChanged,
        replaced ? "Your Papyra authenticator was replaced" : "An authenticator was added to your Papyra account",
        $"An authenticator app was {(replaced ? "set up again" : "set up")} for @{user.Username}. Its codes now confirm sensitive changes.\n\n"
        + "If that wasn't you, change your password now.",
        RequestDetails(user, http), ct);
    return Results.Ok(new { enabled = true });
}).RequireAuthorization().RequireRateLimiting(AuthRateLimit);

auth.MapPost("/totp/remove", async (
    TotpRemoveRequest body, ClaimsPrincipal principal, HttpContext http, AppDbContext db,
    EmailSender mail, LoginThrottle throttle, CancellationToken ct) =>
{
    if (IsApiKey(principal)) return Results.Json(new { error = "Use the app, not an API key." }, statusCode: 403);
    var user = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (user is null) return Results.NotFound();
    if (!TotpService.IsEnabled(user)) return Results.NoContent();
    var key = $"totp:{user.Id}";
    if (throttle.IsLockedOut(key)) return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: 429);
    if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, user.PasswordHash))
    {
        throttle.RecordFailure(key);
        return Results.Json(new { error = "That password isn't right.", field = "password" }, statusCode: 401);
    }
    TotpService.Disable(user);
    await db.SaveChangesAsync(ct);
    throttle.Reset(key);
    await mail.NotifyAsync(user, NotificationCatalog.TotpChanged, "Your Papyra authenticator was removed",
        $"The authenticator app on @{user.Username} was removed.\n\nIf that wasn't you, change your password now.",
        RequestDetails(user, http), ct);
    return Results.NoContent();
}).RequireAuthorization().RequireRateLimiting(AuthRateLimit);

// Live "is this username free?" for the profile form. Usernames are unique per
// Papyra, case-insensitively. Answers only what the mention typeahead already
// does, and under the same per-account budget.
auth.MapGet("/username-available", async (string? name, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
{
    var wanted = name?.Trim() ?? string.Empty;
    if (ProfileRules.UsernameProblem(wanted) is { } problem) return Results.Ok(new { available = false, problem });
    var id = int.Parse(Uid(principal));
    var lower = wanted.ToLower();
    var taken = await db.Users.AnyAsync(u => u.Id != id && u.Username.ToLower() == lower, ct);
    return Results.Ok(new { available = !taken, problem = taken ? "That username is taken on this Papyra." : null });
}).RequireAuthorization().RequireRateLimiting(UserSearchRateLimit);

// Remove the profile picture; the initial takes its place everywhere.
auth.MapDelete("/avatar", (ClaimsPrincipal principal, IConfiguration config, IHostEnvironment env) =>
{
    var dir = PapyraPaths.UserDotPapyra(config, env.ContentRootPath, Uid(principal));
    if (Directory.Exists(dir))
        foreach (var old in Directory.EnumerateFiles(dir, "avatar.*")) File.Delete(old);
    return Results.NoContent();
}).RequireAuthorization();

auth.MapPost("/password", async (
    PasswordRequest body, ClaimsPrincipal principal, AppDbContext db, UnlockTokenStore unlockTokens,
    EmailSender email, GitSyncService git, HttpContext http, CancellationToken ct) =>
{
    if (PasswordPolicy.Validate(body.Next) is { } weak)
        return Results.BadRequest(new { error = weak });

    var id = int.Parse(Uid(principal));
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (!BCrypt.Net.BCrypt.Verify(body.Current ?? string.Empty, user.PasswordHash))
        return Results.Json(new { error = "Current password is incorrect." }, statusCode: StatusCodes.Status400BadRequest);

    user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(body.Next);
    user.PasswordChangedUtc = DateTime.UtcNow;
    // Picking your own password is exactly what the flag was waiting for.
    user.MustChangePassword = false;
    await RewrapGitBackupKeyAsync(db, git, user.Id.ToString(), body.Next!, ct);
    await db.SaveChangesAsync(ct);
    unlockTokens.RevokeUser(user.Id.ToString());
    await email.NotifyAsync(user, NotificationCatalog.PasswordChanged,
        "Your Papyra password was changed",
        $"The password for \"{user.Username}\" was just changed from inside Papyra.\n\n"
        + "If that wasn't you, reset it from the sign-in page straight away and tell your Papyra administrator.",
        RequestDetails(user, http), ct);
    return Results.NoContent();
}).RequireAuthorization();

// Largest profile picture accepted. The browser sends a 512px square PNG, which
// is tens of kilobytes; this is headroom, not a target.
const long MaxAvatarBytes = 4L * 1024 * 1024;

// Upload a profile picture. The browser crops it to a square and re-encodes it
// as PNG before it gets here (see components/AvatarCropper.tsx), so this is the
// gate rather than the resizer: it takes the bytes only if they really are one
// of three raster formats, and stores them under an extension it chose itself.
//
// The old version trusted `file.FileName` for the extension and had no size cap,
// so an "avatar.svg" was stored and later served as image/svg+xml from the app's
// own origin — an SVG carries script, and navigating to that URL would run it.
auth.MapPost("/avatar", async (
    IFormFile file, ClaimsPrincipal principal, IConfiguration config, IHostEnvironment env, CancellationToken ct) =>
{
    if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file." });
    if (file.Length > MaxAvatarBytes)
        return Results.BadRequest(new { error = "That picture is too large. 4 MB is the limit." });

    // Read it once, decide from the bytes.
    using var buffer = new MemoryStream();
    await file.CopyToAsync(buffer, ct);
    var bytes = buffer.ToArray();
    if (SniffImage(bytes) is not { } image)
        return Results.BadRequest(new { error = "That file isn't a PNG, JPEG or WebP image." });

    var dir = PapyraPaths.UserDotPapyra(config, env.ContentRootPath, Uid(principal));
    Directory.CreateDirectory(dir);
    // One avatar per user: clear any prior file, then write avatar.<ext> atomically.
    foreach (var old in Directory.EnumerateFiles(dir, "avatar.*")) File.Delete(old);

    var dest = Path.Combine(dir, $"avatar{image.Extension}");
    var tmp = Path.Combine(dir, $"{Guid.NewGuid():N}.tmp");
    await File.WriteAllBytesAsync(tmp, bytes, ct);
    File.Move(tmp, dest, overwrite: true);
    return Results.Ok(new { ok = true });
}).RequireAuthorization().DisableAntiforgery();

auth.MapGet("/avatar", (ClaimsPrincipal principal, HttpResponse response, IConfiguration config, IHostEnvironment env) =>
    AvatarFile(Uid(principal), config, env, response)).RequireAuthorization();

// Somebody else's picture, by username. A face next to a name is the point of
// having one, and these appear wherever a person does: the inbox, a shared note,
// the roster. Nothing leaks that the directory typeahead doesn't already give
// any signed-in user — an unknown name and a user with no picture answer the
// same 404.
auth.MapGet("/avatar/{username}", async (
    string username, HttpResponse response, AppDbContext db, IConfiguration config, IHostEnvironment env, CancellationToken ct) =>
{
    var name = username.Trim();
    var id = await db.Users.Where(u => u.Username == name).Select(u => (int?)u.Id).FirstOrDefaultAsync(ct);
    return id is null ? Results.NotFound() : AvatarFile(id.Value.ToString(), config, env, response);
}).RequireAuthorization();

// ── Background jobs ───────────────────────────────────────────────────────────
// Admin-only, because these describe the whole instance rather than one vault,
// and running one affects everybody's notes.
var jobsApi = app.MapGroup("/api/jobs").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

jobsApi.MapGet("/", (JobRegistry jobs) => Results.Ok(jobs.Snapshot().Select(j => new
{
    j.Id,
    j.Name,
    j.Description,
    kind = j.Kind.ToString().ToLowerInvariant(),
    intervalSeconds = j.Interval?.TotalSeconds,
    j.Running,
    // A job that can be asked to run now is exactly one that has a timer — the
    // always-on ones have nothing to start.
    canTrigger = j.Kind != JobKind.Continuous,
    lastRun = j.LastRun is null ? null : new
    {
        startedUtc = j.LastRun.StartedUtc,
        finishedUtc = j.LastRun.FinishedUtc,
        j.LastRun.Ok,
        j.LastRun.Summary,
        j.LastRun.Error,
        durationMs = Math.Round(j.LastRun.DurationMs),
    },
})));

jobsApi.MapPost("/{id}/run", async (string id, JobRegistry jobs, CancellationToken ct) =>
{
    if (!jobs.Knows(id)) return Results.NotFound(new { error = "No such job." });

    var run = await jobs.RunAsync(id, ct);
    if (run is null)
        return Results.BadRequest(new { error = "That job runs by itself and can't be started by hand." });

    // A job that failed is still a completed request: the caller asked for it to
    // run, it ran, and the answer is what happened.
    return Results.Ok(new
    {
        run.Ok,
        run.Summary,
        run.Error,
        durationMs = Math.Round(run.DurationMs),
        finishedUtc = run.FinishedUtc,
    });
});

// ── Admin user management ──────────────────────────────────────────────────────
// Role-gated provisioning for the settings Admin tab. Provisioned users get their
// tenant vault created + watched, same as the first-admin setup flow.
var admin = auth.MapGroup("/users").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

admin.MapGet("/", async (AppDbContext db, CancellationToken ct) =>
    Results.Ok((await db.Users.OrderBy(u => u.Id).ToListAsync(ct)).Select(u => new
    {
        u.Id, u.Username, u.Name, u.Email, u.Role, u.MustChangePassword,
        disabled = u.DisabledUtc is not null,
        disabledUtc = AsUtc(u.DisabledUtc),
        u.DisabledReason,
        lastSignInUtc = AsUtc(u.LastSignInUtc),
        sso = u.ExternalId is not null,
        deletionScheduledUtc = AsUtc(u.DeletionScheduledUtc),
    })));

// Create an account on someone's behalf. The admin may type a first password or
// leave it blank for a generated one; either way the account is flagged
// MustChangePassword, because a password its owner did not choose is a password
// somebody else knows. The password comes back in the response exactly once —
// it is never stored in the clear and no later call can read it again.
admin.MapPost("/", async (
    ProvisionRequest body, AppDbContext db, VaultObserver observer,
    EmailSender email, HttpContext http, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Username))
        return Results.BadRequest(new { error = "Username is required." });

    var chosen = string.IsNullOrWhiteSpace(body.Password);
    var password = chosen ? GeneratePassword() : body.Password!;
    if (!chosen && PasswordPolicy.Validate(password) is { } weak)
        return Results.BadRequest(new { error = weak });

    var username = body.Username.Trim();
    if (await db.Users.AnyAsync(u => u.Username == username, ct))
        return Results.Conflict(new { error = "Username already taken." });

    var address = body.Email?.Trim() ?? string.Empty;
    if (body.SendEmail == true && address.Length == 0)
        return Results.BadRequest(new { error = "Add an email address to send the sign-in details to." });

    var user = new User
    {
        Username = username,
        Name = string.IsNullOrWhiteSpace(body.Name) ? username : body.Name.Trim(),
        Email = address,
        PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
        PasswordChangedUtc = DateTime.UtcNow,
        Role = body.Role == "Admin" ? "Admin" : "User",
        MustChangePassword = true,
    };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);

    observer.WatchUser(user.Id.ToString()); // create + watch the new tenant's vault

    var emailed = false;
    if (body.SendEmail == true)
    {
        var url = email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}");
        var sent = await email.SendAsync(
            address,
            "Your Papyra account is ready",
            $"An account has been created for you on Papyra.\n\n"
            + $"Address: {url}\nUsername: {username}\nFirst password: {password}\n\n"
            + "You will be asked to choose your own password the first time you sign in. "
            + "Until you do, this one is known to whoever set the account up.",
            ct);
        emailed = sent.Sent;
    }

    return Results.Ok(new
    {
        user.Id, user.Username, user.Name, user.Email, user.Role, user.MustChangePassword,
        // Shown once, so the admin can pass it on by hand when no mail went out.
        password,
        emailed,
    });
});

// Reset someone's password to one the admin can read out. Same bargain as
// provisioning: typed or generated, returned once, and the account must change
// it before it can be used for anything else.
admin.MapPost("/{id:int}/reset", async (
    int id, ResetRequest body, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var generated = string.IsNullOrWhiteSpace(body.Password);
    var password = generated ? GeneratePassword() : body.Password!;
    if (!generated && PasswordPolicy.Validate(password) is { } weak)
        return Results.BadRequest(new { error = weak });

    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(password);
    user.PasswordChangedUtc = DateTime.UtcNow;
    user.MustChangePassword = true;
    await db.SaveChangesAsync(ct);

    var emailed = false;
    if (body.SendEmail == true && !string.IsNullOrWhiteSpace(user.Email))
    {
        var sent = await email.NotifyAsync(
            user, NotificationCatalog.PasswordReset,
            "Your Papyra password was reset",
            $"An administrator reset the password for \"{user.Username}\".\n\n"
            + $"Temporary password: {password}\n\n"
            + "You will be asked to choose your own the next time you sign in.",
            ct: ct);
        emailed = sent.Sent;
    }

    return Results.Ok(new { password, emailed });
});

// A recovery link for an account whose owner can't sign in and shouldn't be read
// a password down the phone. Same one-hour, single-use token as the self-service
// "forgot password" flow — the difference is only who asked for it. Returned to
// the admin so it can be handed over out of band when mail isn't configured.
admin.MapPost("/{id:int}/recovery-link", async (
    int id, RecoveryLinkRequest body, AppDbContext db, EmailSender email,
    HttpContext http, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (body.SendEmail == true && string.IsNullOrWhiteSpace(user.Email))
        return Results.BadRequest(new { error = "That account has no email address to send to." });

    var (token, hash) = NewAuthToken();
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = hash,
        Kind = "reset",
        UserId = user.Id,
        Email = user.Email,
        Username = user.Username,
        ExpiresUtc = DateTime.UtcNow.AddHours(1),
    });
    await db.SaveChangesAsync(ct);

    var link = $"{email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}")}/reset-password?token={token}";

    var emailed = false;
    if (body.SendEmail == true)
    {
        var sent = await email.NotifyAsync(
            user, NotificationCatalog.PasswordReset,
            "Reset your Papyra password",
            $"An administrator started a password reset for \"{user.Username}\".\n\n"
            + $"Set a new one here:\n{link}\n\n"
            + "This link expires in 1 hour and can be used once.",
            ct: ct);
        emailed = sent.Sent;
    }

    return Results.Ok(new { link, expiresInMinutes = 60, emailed });
});

// Delete a user account. Refuses self-deletion (avoid locking yourself out) and
// removing the last admin. Clears the account's API keys + shares (owned and
// received); the user's note files stay on disk (the source of truth) so nothing
// is silently destroyed — a self-hoster can reclaim or re-import them.
admin.MapDelete("/{id:int}", async (int id, ClaimsPrincipal me, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    if (id == int.Parse(Uid(me)))
        return Results.BadRequest(new { error = "You can't delete your own account." });

    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();

    if (user.Role == "Admin" && await db.Users.CountAsync(u => u.Role == "Admin", ct) <= 1)
        return Results.BadRequest(new { error = "Can't delete the last admin." });

    db.ApiKeys.RemoveRange(db.ApiKeys.Where(k => k.UserId == id));
    db.Shares.RemoveRange(db.Shares.Where(s => s.OwnerId == id || s.GranteeUserId == id));
    db.AccessRequests.RemoveRange(db.AccessRequests.Where(r => r.OwnerId == id || r.RequesterUserId == id));
    db.Notifications.RemoveRange(db.Notifications.Where(n => n.UserId == id || n.ActorUserId == id));
    db.KnownDevices.RemoveRange(db.KnownDevices.Where(d => d.UserId == id));
    db.Users.Remove(user);
    await db.SaveChangesAsync(ct);
    await TellOtherAdmins(db, email, int.Parse(Uid(me)), $"{user.Username}'s account was deleted",
        $"The account \"{user.Username}\" was deleted by @{me.Identity?.Name}. Their note files stay on the server's disk.", ct);
    return Results.NoContent();
});

// Promote to admin or return to a regular account. Takes effect on the person's
// very next request (the account-standing middleware re-reads the role), so no
// sign-out is needed either way. You can't change your own role — another admin
// has to — and the last active admin can't be demoted, or nobody could manage
// the instance any more.
admin.MapPut("/{id:int}/role", async (
    int id, RoleChangeRequest body, ClaimsPrincipal me, AppDbContext db, EmailSender email,
    IHubContext<NotesHub> hub, CancellationToken ct) =>
{
    var role = body.Role switch { "Admin" => "Admin", "User" => "User", _ => null };
    if (role is null) return Results.BadRequest(new { error = "Role must be Admin or User." });
    if (id == int.Parse(Uid(me)))
        return Results.BadRequest(new { error = "You can't change your own role. Ask another admin." });

    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();
    if (user.Role == role) return Results.Ok(new { user.Id, user.Role });

    if (user.Role == "Admin" && await ActiveAdminsOtherThan(db, id, ct) == 0)
        return Results.BadRequest(new { error = "That's the last active admin. Make someone else an admin first." });

    user.Role = role;
    await db.SaveChangesAsync(ct);
    // Their open tabs re-read who they are, so admin pages appear or go at once.
    await hub.Clients.User(id.ToString()).SendAsync("AccountChanged", ct);

    await email.NotifyAsync(user, NotificationCatalog.AccountStatus,
        role == "Admin" ? "You're now an administrator on Papyra" : "Your Papyra account is now a regular account",
        role == "Admin"
            ? $"@{me.Identity?.Name} made \"{user.Username}\" an administrator. You can now manage accounts and "
              + "this server's settings from Settings. Administrators still can't read anyone else's notes."
            : $"@{me.Identity?.Name} changed \"{user.Username}\" back to a regular account. Your notes are untouched; "
              + "the administration pages are no longer available to you.",
        ct: ct);
    await TellOtherAdmins(db, email, int.Parse(Uid(me)),
        $"{user.Username} is now {(role == "Admin" ? "an admin" : "a regular user")}",
        $"@{me.Identity?.Name} changed the role of \"{user.Username}\" to {role}.", ct, exceptUserId: user.Id);
    return Results.Ok(new { user.Id, user.Role });
});

// Lock an account out — a leaked password, a person who left — without deleting
// anything. Every way in is refused while it is disabled (password, passkey,
// SSO, API keys, reset links) and sessions already open end on their next request.
admin.MapPost("/{id:int}/disable", async (
    int id, DisableRequest body, ClaimsPrincipal me, AppDbContext db, EmailSender email,
    UnlockTokenStore unlockTokens, IHubContext<NotesHub> hub, CancellationToken ct) =>
{
    if (id == int.Parse(Uid(me)))
        return Results.BadRequest(new { error = "You can't disable your own account." });
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();
    if (user.DisabledUtc is not null) return Results.NoContent();
    if (user.Role == "Admin" && await ActiveAdminsOtherThan(db, id, ct) == 0)
        return Results.BadRequest(new { error = "That's the last active admin." });

    var reason = body.Reason?.Trim();
    user.DisabledUtc = DateTime.UtcNow;
    user.DisabledReason = string.IsNullOrEmpty(reason) ? null : reason[..Math.Min(reason.Length, 200)];
    // Outstanding reset links would be a way back in.
    await db.AuthTokens.Where(t => t.UserId == id && t.UsedUtc == null)
        .ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedUtc, DateTime.UtcNow), ct);
    await db.SaveChangesAsync(ct);
    unlockTokens.RevokeUser(id.ToString());
    // Open tabs find out now rather than at their next save.
    await hub.Clients.User(id.ToString()).SendAsync("AccountDisabled", ct);

    await email.NotifyAsync(user, NotificationCatalog.AccountStatus,
        "Your Papyra account has been disabled",
        $"An administrator disabled \"{user.Username}\". You can't sign in until it is turned back on. "
        + "Your notes are kept exactly as they were.\n\n"
        + "If you weren't expecting this, contact the person who runs your Papyra.",
        ct: ct);
    await TellOtherAdmins(db, email, int.Parse(Uid(me)), $"{user.Username}'s account was disabled",
        $"@{me.Identity?.Name} disabled \"{user.Username}\"."
        + (user.DisabledReason is null ? string.Empty : $"\n\nReason given: {user.DisabledReason}"), ct, exceptUserId: user.Id);
    return Results.NoContent();
});

admin.MapPost("/{id:int}/enable", async (
    int id, ClaimsPrincipal me, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([id], ct);
    if (user is null) return Results.NotFound();
    if (user.DisabledUtc is null) return Results.NoContent();
    user.DisabledUtc = null;
    user.DisabledReason = null;
    await db.SaveChangesAsync(ct);

    await email.NotifyAsync(user, NotificationCatalog.AccountStatus,
        "Your Papyra account is active again",
        $"An administrator turned \"{user.Username}\" back on — you can sign in again.\n\n"
        + "If your password may have leaked, choose a new one under Settings → Profile after you sign in.",
        ct: ct);
    await TellOtherAdmins(db, email, int.Parse(Uid(me)), $"{user.Username}'s account was re-enabled",
        $"@{me.Identity?.Name} turned \"{user.Username}\" back on.", ct, exceptUserId: user.Id);
    return Results.NoContent();
});

// ── User directory (mention typeahead) ────────────────────────────────────────
// Typing `@` needs to resolve a name to a real account, but /api/auth/users is
// admin-only and handing the full roster to every tenant on a shared instance is
// too much to trade for autocomplete. This is the narrow version: prefix-only,
// two characters minimum, at most eight rows, and username + display name are the
// only fields that leave — no id, no email, no role. A determined caller can still
// enumerate by walking prefixes, which is inherent to any typeahead; the rate limit
// makes that slow and visible rather than free.
var directory = app.MapGroup("/api/users").RequireAuthorization().WithTags("Directory");

directory.MapGet("/search", async (string? q, ClaimsPrincipal me, AppDbContext db, CancellationToken ct) =>
{
    var query = (q ?? string.Empty).Trim();
    // A username is [A-Za-z0-9._-], so anything else is not a prefix any account
    // could have — reject it here rather than spending a query on it.
    // This also keeps LIKE metacharacters out of the pattern. EF already escapes
    // them (the translation is `LIKE @p ESCAPE '\'`, so a `%` is matched
    // literally), but a bare `%` matching the entire roster is the one failure
    // this endpoint must never have, and that guarantee is worth more than a
    // dependency on a provider translation detail.
    if (query.Length > 64 || !query.All(IsUsernameChar))
        return Results.Ok(Array.Empty<UserSuggestion>());

    var meId = int.Parse(Uid(me));
    var prefix = query.ToLowerInvariant();
    // An empty query lists the first page of accounts rather than nothing. This
    // endpoint originally required two characters, on the theory that it made the
    // roster harder to enumerate — but the only caller is the `@` typeahead, and
    // typing `@` is exactly when a person expects to see who they can mention.
    // The old rule meant the dropdown stayed empty until the third keystroke,
    // which reads as "mentions are broken". The privacy it bought was thin
    // anyway: an authenticated user on a self-hosted vault can page through
    // prefixes, and the cap plus the per-account rate limit are what actually
    // bound the exposure.
    var matches = await db.Users
        // Self is excluded: a self-mention is dropped at delivery, so offering it
        // would only invite a ping that silently goes nowhere.
        .Where(u => u.Id != meId && (prefix.Length == 0 || u.Username.ToLower().StartsWith(prefix)))
        .OrderBy(u => u.Username)
        .Take(8)
        .Select(u => new UserSuggestion(u.Username, u.Name))
        .ToListAsync(ct);

    return Results.Ok(matches);
}).RequireRateLimiting(UserSearchRateLimit);

// ── Per-user notification preferences ────────────────────────────────────────
// The catalog of everything Papyra can tell a person about, with their switch for
// each. Critical ones come back locked on. Email is the only channel today;
// `channels` is how the settings screen will learn about push.
auth.MapGet("/notifications", async (ClaimsPrincipal me, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(me))], ct);
    if (user is null) return Results.NotFound();
    return Results.Ok(new
    {
        // The UI explains why the switches do nothing on an instance with no
        // mail configured, rather than silently pretending they work.
        emailConfigured = email.IsConfigured,
        hasAddress = !string.IsNullOrWhiteSpace(user.Email),
        channels = NotificationCatalog.Channels,
        groups = NotificationCatalog.Groups
            .Where(g => g.Key != "admin" || user.Role == "Admin")
            .Select(g => new { id = g.Key, label = g.Value }),
        events = NotificationCatalog.Events
            .Where(e => e.Listed && (!e.AdminOnly || user.Role == "Admin"))
            .Select(e => new
            {
                e.Id, e.Group, e.Label, e.Description, e.Critical,
                email = NotificationPrefs.Wants(user, e.Id, NotificationCatalog.Email),
            }),
        // The two original switches, for clients that predate the catalog.
        mention = NotificationPrefs.Wants(user, NotificationCatalog.Mention),
        share = NotificationPrefs.Wants(user, NotificationCatalog.Shared),
    });
}).RequireAuthorization();

auth.MapPut("/notifications", async (
    NotificationPrefsWrite body, ClaimsPrincipal me, AppDbContext db, CancellationToken ct) =>
{
    var user = await db.Users.FindAsync([int.Parse(Uid(me))], ct);
    if (user is null) return Results.NotFound();
    if (body.Mention is { } m) NotificationPrefs.Set(user, NotificationCatalog.Mention, m);
    if (body.Share is { } sh)
    {
        NotificationPrefs.Set(user, NotificationCatalog.Shared, sh);
        NotificationPrefs.Set(user, NotificationCatalog.AccessRequested, sh);
        NotificationPrefs.Set(user, NotificationCatalog.AccessAnswered, sh);
    }
    foreach (var change in body.Events ?? [])
    {
        if (!NotificationPrefs.Set(user, change.Id ?? string.Empty, change.Enabled, change.Channel ?? NotificationCatalog.Email))
            return Results.BadRequest(new { error = NotificationCatalog.Find(change.Id ?? string.Empty) is { Critical: true }
                ? "That notification is always sent — it keeps your account safe."
                : "No such notification." });
    }
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
}).RequireAuthorization();

// ── Admin: SSO (OIDC) configuration ───────────────────────────────────────────
// Admin-only. The client secret is never returned — only whether one is stored —
// so opening the settings page cannot leak it to a shoulder-surfer or a browser
// extension, and saving the form without retyping it keeps the stored value.
var oidcAdmin = auth.MapGroup("/oidc").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

oidcAdmin.MapGet("/", async (InstanceConfigStore config, CancellationToken ct) =>
{
    await config.EnsureLoadedAsync(ct);
    return Results.Ok(new
    {
        enabled = config.GetBool(OidcKeys.Enabled),
        authority = config.GetOrEmpty(OidcKeys.Authority),
        clientId = config.GetOrEmpty(OidcKeys.ClientId),
        hasClientSecret = config.Has(OidcKeys.ClientSecret),
        displayName = config.GetOrEmpty(OidcKeys.DisplayName),
        // The exact URI the IdP must whitelist. Getting this wrong is the most
        // common OIDC setup failure, so hand it to the admin rather than making
        // them infer it.
        redirectUri = "/signin-oidc",
        ready = SsoConfigured(config),
    });
});

oidcAdmin.MapPut("/", async (
    OidcConfigWrite body, InstanceConfigStore config,
    IOptionsMonitorCache<OpenIdConnectOptions> optionsCache, CancellationToken ct) =>
{
    var enabled = body.Enabled == true;
    var authority = body.Authority?.Trim() ?? string.Empty;
    var clientId = body.ClientId?.Trim() ?? string.Empty;

    // Refuse to switch on a configuration that cannot work — otherwise the login
    // screen advertises an SSO button that dead-ends at the IdP.
    if (enabled && (authority.Length == 0 || clientId.Length == 0))
        return Results.BadRequest(new { error = "Authority and Client ID are required to enable SSO." });
    if (authority.Length > 0)
    {
        if (!Uri.TryCreate(authority, UriKind.Absolute, out var authorityUri))
            return Results.BadRequest(new { error = "Authority must be an absolute URL." });
        // Tokens and the client secret cross this connection, so plaintext HTTP
        // is refused outright. Loopback stays allowed for local IdP testing.
        if (authorityUri.Scheme != Uri.UriSchemeHttps && !authorityUri.IsLoopback)
            return Results.BadRequest(new { error = "Authority must use HTTPS (or be a loopback address for testing)." });
    }

    var values = new Dictionary<string, string?>
    {
        [OidcKeys.Enabled] = enabled ? "true" : "false",
        [OidcKeys.Authority] = authority,
        [OidcKeys.ClientId] = clientId,
        [OidcKeys.DisplayName] = body.DisplayName?.Trim() ?? string.Empty,
    };
    // Only overwrite the secret when one was supplied, so saving the form with
    // the field left blank keeps the existing value.
    if (body.ClientSecret is not null) values[OidcKeys.ClientSecret] = body.ClientSecret.Trim();

    await config.SetAsync(values, ct);

    // The auth stack caches resolved options per scheme; without this eviction
    // the handler would keep using the previous IdP until the process restarted,
    // which is the entire problem this feature exists to solve.
    optionsCache.TryRemove("oidc");

    return Results.NoContent();
})
    .WithSummary("Configure SSO (admin)")
    .WithDescription(
        "Stores the OIDC authority, client id and secret. Takes effect immediately — " +
        "the cached authentication options for the `oidc` scheme are evicted on save.");

// ── Admin: outbound mail (SMTP) ───────────────────────────────────────────────
// Admin-only, same shape as the SSO panel: the password is write-only, and a
// test send proves the settings before anyone depends on them for a reset link.
var smtpAdmin = auth.MapGroup("/smtp").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

smtpAdmin.MapGet("/", async (InstanceConfigStore config, CancellationToken ct) =>
{
    await config.EnsureLoadedAsync(ct);
    return Results.Ok(new
    {
        enabled = config.GetBool(SmtpKeys.Enabled),
        host = config.GetOrEmpty(SmtpKeys.Host),
        port = config.GetInt(SmtpKeys.Port, 587),
        useSsl = config.GetBool(SmtpKeys.UseSsl),
        username = config.GetOrEmpty(SmtpKeys.Username),
        hasPassword = config.Has(SmtpKeys.Password),
        fromAddress = config.GetOrEmpty(SmtpKeys.FromAddress),
        fromName = config.GetOrEmpty(SmtpKeys.FromName),
        publicUrl = config.GetOrEmpty(SmtpKeys.PublicUrl),
    });
});

smtpAdmin.MapPut("/", async (SmtpConfigWrite body, InstanceConfigStore config, CancellationToken ct) =>
{
    var (values, problem) = SmtpValues(body);
    if (problem is not null) return Results.BadRequest(new { error = problem });
    await config.SetAsync(values!, ct);
    return Results.NoContent();
})
    .WithSummary("Configure outbound email (admin)");

// Prove the settings work before anyone's password reset depends on them.
smtpAdmin.MapPost("/test", async (
    SmtpTestRequest body, ClaimsPrincipal me, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(me));
    var self = await db.Users.FindAsync([uid], ct);
    var to = string.IsNullOrWhiteSpace(body.To) ? self?.Email : body.To.Trim();
    if (string.IsNullOrWhiteSpace(to))
        return Results.BadRequest(new { error = "No address to send to — set one on your profile or type one here." });

    var result = await email.SendAsync(
        to,
        "Papyra test email",
        "This is a test message from your Papyra instance.\n\n"
        + "If you're reading this, outbound email is working.",
        ct);

    return result.Sent
        ? Results.Ok(new { sent = true, to })
        : Results.BadRequest(new { sent = false, error = result.Error });
})
    .WithSummary("Send a test email (admin)");

// ── Admin: invitations ────────────────────────────────────────────────────────
// Invite by email instead of handing out a password. The token is single-use and
// short-lived; the account is created only when the invitee sets their password,
// so an unaccepted invite leaves nothing behind but an expiring row.
smtpAdmin.MapPost("/invite", async (
    InviteRequest body, AppDbContext db, EmailSender email, HttpContext http, CancellationToken ct) =>
{
    var username = body.Username?.Trim() ?? string.Empty;
    var address = body.Email?.Trim() ?? string.Empty;
    if (username.Length == 0 || address.Length == 0)
        return Results.BadRequest(new { error = "Username and email are required." });
    if (!MailAddress.TryCreate(address, out _))
        return Results.BadRequest(new { error = "That is not a valid email address." });
    if (await db.Users.AnyAsync(u => u.Username == username, ct))
        return Results.Conflict(new { error = "Username already taken." });
    if (!email.IsConfigured)
        return Results.BadRequest(new { error = "Configure outbound email before sending invitations." });

    var (token, hash) = NewAuthToken();
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = hash,
        Kind = "invite",
        Email = address,
        Username = username,
        Role = body.Role == "Admin" ? "Admin" : "User",
        ExpiresUtc = DateTime.UtcNow.AddDays(7),
    });
    await db.SaveChangesAsync(ct);

    var link = $"{email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}")}/accept-invite?token={token}";
    var result = await email.SendAsync(
        address,
        "You've been invited to Papyra",
        $"You've been invited to join a Papyra vault as \"{username}\".\n\n"
        + $"Set your password to finish signing up:\n{link}\n\n"
        + "This link expires in 7 days. If you weren't expecting it, ignore this email.",
        ct);

    return result.Sent
        ? Results.Ok(new { sent = true })
        : Results.BadRequest(new { sent = false, error = result.Error });
})
    .WithSummary("Invite a user by email (admin)");

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
    if (IsApiKey(user) || !unlockTokens.IsValid(token, uid))
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
// pinning a note to a fractional Key, kept until the note is dragged again (an
// edit no longer resets it). `SetAt` records when the drag happened.
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
    MentionDeliveryService mentions,
    EmbeddingService embeddings,
    VaultObserverOptions vault,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    HttpContext http,
    ICollabEngine collab,
    NoteWriteLocks writeLocks,
    CancellationToken ct) =>
{
    // A new note's file starts under its id until it has a title (then it is
    // renamed — see NoteFileNamer). PathGuard stops it escaping the vault, but
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
    // Where it is now; a new note's file is named below, once its title is known.
    var path = priorPath;

    // Locking and unlocking a note are the two moves the vault has to police.
    // Locking needs a PIN to exist — a secure note must always have a way in that
    // does not depend on one device. Unlocking (secure → plain) releases the body
    // into the list, search and snapshots, so it needs the vault open right now:
    // a stolen session alone must not be able to take the lock off.
    var wasSecure = prior?.Secure ?? false;
    var wantsSecure = body.Secure ?? wasSecure;
    if (wantsSecure && !wasSecure)
    {
        var owner = await http.RequestServices.GetRequiredService<AppDbContext>().Users.FindAsync([int.Parse(uid)], ct);
        if (string.IsNullOrEmpty(owner?.VaultPinHash))
            return Results.Json(new { error = "Set a vault PIN before locking a note.", code = "pin_not_set" },
                statusCode: StatusCodes.Status409Conflict);
    }
    if (wasSecure && !wantsSecure && !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock the vault to take the lock off a note.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);

    // Tags: normalised (trimmed, de-duplicated) and capped — see TagPolicy.
    var tags = TagPolicy.Normalize(body.Tags);
    if (TagPolicy.Validate(tags, prior?.Tags.Count ?? 0) is { } badTags)
        return Results.BadRequest(new { error = badTags, code = "tags_invalid" });

    var note = new Note
    {
        Id = id,
        Title = body.Title ?? string.Empty,
        Tags = tags,
        Color = body.Color,
        Pinned = body.Pinned,
        Archived = body.Archived,
        // A locked note's body never rides the note list, so a save built from the
        // list (an older client's card pin/archive toggle) carries an empty body it
        // never saw — and writing that through erased the note. Only that exact
        // shape is caught: the open editor's autosave carries no unlock token
        // either, so any non-empty body must still land as written.
        Body = wasSecure && wantsSecure && string.IsNullOrEmpty(body.Body)
               && !UnlockedNow(http, uid) && prior is not null
            ? prior.Body
            : body.Body ?? string.Empty,
        Kind = string.Equals(body.Kind, "todo", StringComparison.OrdinalIgnoreCase) ? "todo" : "note",
        // Omitted `secure` keeps whatever the note already had — a client that
        // doesn't know about the flag must never silently unlock a secure note.
        Secure = body.Secure ?? prior?.Secure ?? false,
        // Trash state belongs to /trash and /untrash, never to a content save. A
        // save used to rebuild the note without it, so an editor's last autosave
        // landing just after "Delete" (or an offline save replayed later) quietly
        // pulled the note back out of Trash — and re-dated it to the top.
        Trashed = prior?.Trashed ?? false,
        TrashedAt = prior?.TrashedAt,
        Updated = DateTime.UtcNow,
    };

    // The file is named after the note — its title, else its first line — and
    // follows it as that changes (see NoteFileNamer). Identity is the `id` in
    // the front matter, so a rename breaks nothing that points at the note.
    var desiredName = NoteFileNamer.DesiredBaseName(note);
    if (path is null)
    {
        var notesDir = vault.UserNotesDir(uid);
        Directory.CreateDirectory(notesDir);
        var fresh = NoteFileNamer.NewPath(notesDir, desiredName, id);
        path = PathGuard.ResolveAndVerify(notesDir, Path.GetFileName(fresh), loggerFactory.CreateLogger("PathGuard"));
    }

    // Locking a note someone has open live: save the room and close it for
    // good first, then lock exactly what the room saved.
    var closedRoom = prior is not null && note.Secure && !wasSecure && await collab.IsRoomActiveAsync(uid, id, ct);
    if (closedRoom) await collab.CloseAsync(uid, id, flush: true, ct);

    // From here to the write, nothing else may write this note — a live room
    // saves its body in the background (see NoteWriteLocks).
    using var writeLock = await writeLocks.AcquireAsync(uid, id, ct);
    if (prior is not null && File.Exists(path))
    {
        var onDisk = await storage.ReadAsync(path, ct);
        // A live editor's metadata save (header) or any save that didn't touch
        // the body keeps the body as it is on disk right now — the freshest
        // copy, possibly just saved by the room — never a stale one.
        if (onDisk is not null && (http.Request.Headers.ContainsKey(CollabEndpoints.CollabClientHeader)
                                   || note.Body == prior.Body
                                   || closedRoom))
            note.Body = onDisk.Body;
        else if (await CollabEndpoints.BodyWriteGuardAsync(collab, uid, id, onDisk?.Body, note.Body, ct) is { } busy)
            return busy;
    }

    // Snapshot the prior on-disk revision before we overwrite it (throttled).
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, loggerFactory.CreateLogger("PathGuard"));
    await snapshots.CaptureAsync(noteSnapDir, path, ct);

    if (priorPath is not null)
        path = NoteFileNamer.Move(uid, path, NoteFileNamer.TargetPath(path, desiredName, id),
            state, writeRing, loggerFactory.CreateLogger("NoteFileNamer"));

    writeRing.Mark(path); // log self-write before touching disk (loop prevention)
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.IndexNote(uid, note); // watcher skips our own write echo, so index here

    archiver.Enqueue(uid, id, note.Body); // background-archive any new URLs in the body

    // Re-embed for semantic search — but never a secure note: its chunks would sit
    // in the vector cache as plaintext, outside the unlock gate.
    if (!note.Secure) embeddings.Enqueue(uid, id, note.Body);

    // Deliver any NEWLY added @mention to that user's inbox. Never from a secure
    // note: its body is withheld everywhere else, and a mention would carry a
    // block of it out to another account.
    if (!note.Secure)
        mentions.Enqueue(uid, user.Identity?.Name ?? uid, id, note.Body, prior?.Body);

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
    ICollabEngine collab,
    CollabStateStore collabStates,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null) return Results.NotFound();

    // Anyone still in the note's live room is sent away; nothing is saved.
    await collab.CloseAsync(uid, id, flush: false, ct);
    collabStates.Delete(uid, id);

    writeRing.Mark(path); // watcher ignores the delete echo
    if (File.Exists(path)) File.Delete(path);
    state.Remove(uid, path);
    search.RemoveNote(uid, id); // watcher skips the echo, so drop from the index here
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
    EmbeddingService embeddings, ICollabEngine collab, NoteWriteLocks writeLocks, CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();

    // A live room saves what everyone typed, then closes: nothing is lost.
    await collab.CloseAsync(uid, id, flush: true, ct);
    using var writeLock = await writeLocks.AcquireAsync(uid, id, ct);
    note = await storage.ReadAsync(path, ct) ?? note;

    note.Trashed = true;
    note.TrashedAt = DateTime.UtcNow;
    writeRing.Mark(path);
    await storage.WriteAsync(path, note, ct);
    state.Upsert(uid, path, note);
    search.RemoveNote(uid, id); // hidden from search while trashed
    await embeddings.RemoveNoteAsync(uid, id, ct); // and from semantic search + RAG
    return Results.NoContent();
});

notes.MapPost("/{id}/untrash", async (
    string id, ClaimsPrincipal user, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    EmbeddingService embeddings, NoteWriteLocks writeLocks, CancellationToken ct) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();
    using var writeLock = await writeLocks.AcquireAsync(uid, id, ct);
    note = await storage.ReadAsync(path, ct) ?? note;

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

// ── Bulk flags (multi-select) ─────────────────────────────────────────────────────
// One request for a selection: pin/unpin, archive/unarchive, trash/untrash. Only
// the flag moves — the body is never sent or rewritten, so a locked note in the
// selection is as safe as any other. Every id gets its own verdict, and one bad
// id never sinks the rest: "changed", "unchanged" (already in that state) or
// "notFound" (not the caller's, or gone).
notes.MapPost("/bulk", async (
    BulkNoteAction body, ClaimsPrincipal user, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    EmbeddingService embeddings, WebhookDispatcherService webhooks,
    IHubContext<NotesHub> hub, ICollabEngine collab, CollabStateStore collabStates, NoteWriteLocks writeLocks,
    CancellationToken ct) =>
{
    var action = body.Action?.Trim().ToLowerInvariant();
    if (action is not ("pin" or "unpin" or "archive" or "unarchive" or "trash" or "untrash" or "delete"))
        return Results.BadRequest(new { error = "action must be pin, unpin, archive, unarchive, trash, untrash or delete." });
    var ids = (body.Ids ?? []).Where(i => !string.IsNullOrWhiteSpace(i)).Distinct(StringComparer.Ordinal).ToList();
    if (ids.Count == 0) return Results.BadRequest(new { error = "No notes selected." });
    if (ids.Count > BulkNoteAction.MaxIds)
        return Results.BadRequest(new { error = $"Select at most {BulkNoteAction.MaxIds} notes at a time." });

    var uid = Uid(user);
    var results = new List<object>(ids.Count);
    var changed = 0;
    foreach (var id in ids)
    {
        var path = state.PathFor(uid, id);
        if (path is null || !state.TryGet(uid, path, out var note) || note is null)
        {
            results.Add(new { id, status = "notFound" });
            continue;
        }

        // Permanent delete empties Trash, and only Trash: a note that isn't in it
        // is refused ("notTrashed"), so no selection mistake can skip the
        // recoverable step.
        if (action == "delete")
        {
            if (!note.Trashed)
            {
                results.Add(new { id, status = "notTrashed" });
                continue;
            }
            await collab.CloseAsync(uid, id, flush: false, ct);
            collabStates.Delete(uid, id);
            writeRing.Mark(path);
            if (File.Exists(path)) File.Delete(path);
            state.Remove(uid, path);
            search.RemoveNote(uid, id);
            await embeddings.RemoveNoteAsync(uid, id, ct);
            await hub.Clients.User(uid).SendAsync("NoteDeleted", new { id }, ct);
            results.Add(new { id, status = "changed" });
            changed++;
            continue;
        }

        // Trashing closes any live room after it saves; every flag write then
        // re-reads the body under the note's write lock (see NoteWriteLocks).
        if (action == "trash") await collab.CloseAsync(uid, id, flush: true, ct);
        using var writeLock = await writeLocks.AcquireAsync(uid, id, ct);
        note = await storage.ReadAsync(path, ct) ?? note;

        var before = (note.Pinned, note.Archived, note.Trashed);
        switch (action)
        {
            case "pin": note.Pinned = true; break;
            case "unpin": note.Pinned = false; break;
            case "archive": note.Archived = true; break;
            case "unarchive": note.Archived = false; break;
            case "trash": note.Trashed = true; note.TrashedAt ??= DateTime.UtcNow; break;
            case "untrash": note.Trashed = false; note.TrashedAt = null; break;
        }
        if (before == (note.Pinned, note.Archived, note.Trashed))
        {
            results.Add(new { id, status = "unchanged" });
            continue;
        }

        writeRing.Mark(path);
        await storage.WriteAsync(path, note, ct);
        note.Updated = File.GetLastWriteTimeUtc(path);
        state.Upsert(uid, path, note);
        if (action == "trash")
        {
            search.RemoveNote(uid, id);
            await embeddings.RemoveNoteAsync(uid, id, ct);
        }
        else
        {
            search.IndexNote(uid, note);
            if (action == "untrash" && !note.Secure) embeddings.Enqueue(uid, id, note.Body);
        }
        if (before.Pinned != note.Pinned)
            webhooks.Enqueue(uid, WebhookEvents.PinToggled, WebhookPayload(WebhookEvents.PinToggled, note));
        await hub.Clients.User(uid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);

        results.Add(new { id, status = "changed" });
        changed++;
    }

    return Results.Ok(new { changed, results });
})
.WithSummary("Pin, archive or trash many notes at once");

// ── Backlinks (ghost cards) ──────────────────────────────────────────────────────
// Notes that link to this one via a `[[Title]]` wikilink. Detection runs against
// the in-memory vault (the authority) by literal substring — Lucene's analyzer
// strips the `[[ ]]` brackets, so an exact wikilink match isn't reliable there; the
// highlighter still builds the ~150-char snippet around the title mention.
// ── Inbox (Phase 15.2) ────────────────────────────────────────────────────────
// Blocks other people have pinged the caller with. Entries are resolved
// server-side so the client never fans out one request per reference, and each
// resolution re-checks the grant.
var inbox = app.MapGroup("/api/inbox").RequireAuthorization().WithTags("Inbox");

inbox.MapGet("/", async (ClaimsPrincipal user, VaultState state, AppDbContext db, CancellationToken ct) =>
{
    if (!int.TryParse(Uid(user), out var callerId)) return Results.Unauthorized();

    var grants = await db.BlockGrants
        .Where(g => g.GranteeUserId == callerId && g.DismissedUtc == null)
        .OrderByDescending(g => g.CreatedUtc)
        .ToListAsync(ct);

    // Access is to the whole note or nothing: a mention is a notification, and
    // what the recipient may see of it is exactly what a Share of that note
    // allows. No share → who and when only, plus a way to ask for access.
    var shareRows = await db.Shares
        .Where(s => s.GranteeUserId == callerId && s.Kind == "user")
        .Select(s => new { s.Id, s.OwnerId, s.NoteId, s.Access })
        .ToListAsync(ct);
    var sharesByNote = shareRows.ToDictionary(s => (s.OwnerId, s.NoteId));
    var pendingRequests = (await db.AccessRequests
            .Where(r => r.RequesterUserId == callerId && r.Status == "pending")
            .Select(r => new { r.OwnerId, r.NoteId })
            .ToListAsync(ct))
        .Select(r => (r.OwnerId, r.NoteId)).ToHashSet();

    var entries = grants.Select(g =>
    {
        sharesByNote.TryGetValue((g.SourceOwnerId, g.SourceNoteId), out var share);
        var ownerUid = g.SourceOwnerId.ToString();
        var ownerPath = state.PathFor(ownerUid, g.SourceNoteId);
        Note? source = null;
        if (ownerPath is not null) state.TryGet(ownerUid, ownerPath, out source);
        // A deleted source, or one that has since been locked, resolves to null —
        // the UI shows a "no longer available" chip rather than an error.
        //
        // An anchored grant is found by its `^id`; one delivered from a block that
        // never had an anchor is found by the line's own text. Both re-read the
        // author's live note on every request, so neither can serve a block the
        // author has since reworded or removed.
        var available = source is not null && !source.Secure && !source.Trashed;
        var visible = available && share is not null;
        var text = !visible
            ? null
            : g.BlockId.Length > 0
                ? BlockResolver.Resolve(source!.Body, g.BlockId)
                : BlockResolver.ResolveLine(source!.Body, g.BlockText);
        return new
        {
            g.Id,
            noteId = g.SourceNoteId,
            g.BlockId,
            from = g.SourceUsername,
            receivedUtc = g.CreatedUtc,
            title = visible ? source!.Title : null,
            text,
            readUtc = g.ReadUtc,
            available,
            shareId = share?.Id,
            access = share?.Access,
            requestPending = pendingRequests.Contains((g.SourceOwnerId, g.SourceNoteId)),
        };
    });

    return Results.Ok(entries);
})
    .WithSummary("List inbox entries")
    .WithDescription("Each entry is one anchored block another user pinged you with, already resolved.");

inbox.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    if (!int.TryParse(Uid(user), out var callerId)) return Results.Unauthorized();
    // Dismissal is the recipient's own act; it never touches the sender's note.
    var grant = await db.BlockGrants.FirstOrDefaultAsync(
        g => g.Id == id && g.GranteeUserId == callerId, ct);
    if (grant is null) return Results.NotFound();
    grant.DismissedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
})
    .WithSummary("Dismiss an inbox entry");

// Mark every outstanding entry read. Called when the recipient opens /inbox —
// the badge counts unread entries, and having looked at the list is what "read"
// means here. Scoped to the caller's own grants; reading never revokes anything.
inbox.MapPost("/read", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    if (!int.TryParse(Uid(user), out var callerId)) return Results.Unauthorized();
    var now = DateTime.UtcNow;
    var marked = await db.BlockGrants
        .Where(g => g.GranteeUserId == callerId && g.DismissedUtc == null && g.ReadUtc == null)
        .ExecuteUpdateAsync(s => s.SetProperty(g => g.ReadUtc, now), ct);
    return Results.Ok(new { marked });
})
    .WithSummary("Mark all inbox entries read");

// ── Block transclusion (Phase 15.1) ───────────────────────────────────────────
// The editor stamps a hidden `^id` anchor onto each block at save time; these
// routes serve ONE anchored block so a note can embed a fragment of another
// (`![[Note#^id]]`) without the reader gaining access to the rest of it.
notes.MapGet("/{id}/blocks", (string id, ClaimsPrincipal user, VaultState state) =>
{
    if (!PathGuard.IsValidNoteId(id)) return Results.NotFound();
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();
    // A secure note's body is withheld until a WebAuthn unlock; its anchors are
    // part of that body, so listing them here would leak the note's structure.
    if (note.Secure) return Results.Forbid();

    return Results.Ok(BlockResolver.Anchors(note.Body)
        .Select(a => new { blockId = a.BlockId, text = a.Text, line = a.Line }));
})
    .WithSummary("List a note's block anchors")
    .WithDescription("Every `^id` anchor in the note, in document order, for building a block reference.");

notes.MapGet("/{id}/blocks/{blockId}", async (
    string id, string blockId, ClaimsPrincipal user, VaultState state, AppDbContext db, CancellationToken ct) =>
{
    if (!PathGuard.IsValidNoteId(id) || !BlockResolver.IsValidBlockId(blockId)) return Results.NotFound();
    var uid = Uid(user);
    var path = state.PathFor(uid, id);

    // Not in the caller's own vault: the only other way in is a BlockGrant, which
    // an @mention created for exactly this block. It authorises this block and
    // nothing else — not the note, not its neighbours.
    if (path is null && int.TryParse(uid, out var callerId))
    {
        var grant = await db.BlockGrants.FirstOrDefaultAsync(
            g => g.GranteeUserId == callerId && g.SourceNoteId == id
                 && g.BlockId == blockId && g.DismissedUtc == null, ct);
        // A mention alone no longer opens any of the note — access is the whole
        // note (a Share) or nothing.
        if (grant is not null && !await db.Shares.AnyAsync(
                s => s.OwnerId == grant.SourceOwnerId && s.NoteId == id
                     && s.Kind == "user" && s.GranteeUserId == callerId, ct))
            grant = null;
        if (grant is not null)
        {
            var ownerUid = grant.SourceOwnerId.ToString();
            var ownerPath = state.PathFor(ownerUid, id);
            if (ownerPath is null || !state.TryGet(ownerUid, ownerPath, out var owned) || owned is null)
                return Results.NotFound();
            if (owned.Secure) return Results.Forbid();
            var granted = BlockResolver.Resolve(owned.Body, blockId);
            if (granted is null) return Results.NotFound();
            return Results.Ok(new { noteId = id, blockId, text = granted, title = owned.Title, via = "grant" });
        }
    }

    // 404 rather than 403 for a missing note: a distinct status would confirm
    // that some other tenant owns that id.
    if (path is null || !state.TryGet(uid, path, out var note) || note is null) return Results.NotFound();
    // Transclusion must not become a bypass of the secure-note gate (17.2):
    // resolving a block IS a body read.
    if (note.Secure) return Results.Forbid();

    var text = BlockResolver.Resolve(note.Body, blockId);
    if (text is null) return Results.NotFound();

    return Results.Ok(new { noteId = id, blockId, text, title = note.Title });
})
    .WithSummary("Resolve one anchored block")
    .WithDescription("Returns only the anchored block's text — never the surrounding note body.");

notes.MapGet("/{id}/backlinks", (string id, ClaimsPrincipal user, VaultState state, SearchIndexService search) =>
{
    var uid = Uid(user);
    var path = state.PathFor(uid, id);
    if (path is null || !state.TryGet(uid, path, out var target) || target is null) return Results.NotFound();

    var title = target.Title;
    if (string.IsNullOrWhiteSpace(title)) return Results.Ok(Array.Empty<object>());

    var needle = $"[[{title}]]";
    var results = state.Snapshot(uid)
        // A secure note is left out entirely: even its title next to a snippet of
        // this note would confirm what it links to.
        .Where(n => !n.Trashed && !n.Secure && n.Id != id && !string.IsNullOrEmpty(n.Body)
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

// ── Tags (the /api/categories routes) ─────────────────────────────────────────────
// The path keeps its original name so existing clients and scripts keep working;
// everywhere a person reads it, it is a tag. A registered tag is a curated note tag. The notes' own `tags` frontmatter is the
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
        return Results.BadRequest(new { error = "Tag name is required." });
    if (name.Length > TagPolicy.MaxTagLength)
        return Results.BadRequest(new { error = $"A tag can be at most {TagPolicy.MaxTagLength} characters." });
    store.Upsert(Uid(user), name, string.IsNullOrWhiteSpace(body.Color) ? null : body.Color);
    return Results.Ok(new { name, color = body.Color });
});

// Delete a tag. Removing it from the registry alone left it on every note that
// carried it, so it reappeared at once — "delete" did nothing anyone could see.
// With ?fromNotes=true the tag is also taken off each of the caller's notes
// (snapshotted first, like any edit, so it can be recovered from history).
categories.MapDelete("/{name}", async (
    string name, bool? fromNotes, ClaimsPrincipal user, CategoryStore store, VaultState state,
    MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search, SnapshotService snapshots,
    IHubContext<NotesHub> hub, IConfiguration config, IHostEnvironment env, ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    store.Remove(uid, name);
    var updated = 0;
    if (fromNotes == true)
    {
        var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
        var logger = loggerFactory.CreateLogger("PathGuard");
        foreach (var note in state.Snapshot(uid).Where(n => n.Tags.Any(t => string.Equals(t, name, StringComparison.OrdinalIgnoreCase))))
        {
            var path = state.PathFor(uid, note.Id);
            if (path is null) continue;
            await snapshots.CaptureAsync(PathGuard.ResolveAndVerify(snapRoot, note.Id, logger), path, ct);
            note.Tags = note.Tags.Where(t => !string.Equals(t, name, StringComparison.OrdinalIgnoreCase)).ToList();
            note.Updated = DateTime.UtcNow;
            writeRing.Mark(path);
            await storage.WriteAsync(path, note, ct);
            state.Upsert(uid, path, note);
            search.IndexNote(uid, note);
            await hub.Clients.User(uid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
            updated++;
        }
    }
    return Results.Ok(new { removed = name, notesUpdated = updated });
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

keys.MapPost("/", async (
    ApiKeyWrite body, ClaimsPrincipal user, AppDbContext db, EmailSender email, HttpContext http, CancellationToken ct) =>
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

    if (await db.Users.FindAsync([uid], ct) is { } owner)
        await email.NotifyAsync(owner, NotificationCatalog.ApiKeyCreated,
            "A new API key was created on your Papyra account",
            "A key that can read and change your notes from scripts and other apps was just created.\n\n"
            + "If that wasn't you, delete it under Settings → API Keys and change your password.",
            [new("Key name", name), new("Starts with", prefix), .. RequestDetails(owner, http)], ct);

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

    // Same rule as the note list: a secure note rides as metadata, body withheld.
    return Results.Ok(state.Snapshot(uid)
        .Where(n => !n.Trashed && SmartCollectionEvaluator.Matches(n, rules))
        .Select(RedactSecure));
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

// ── Git sync (per user) ───────────────────────────────────────────────
// Back up your own vault to your own git remote. Not an admin setting: where a
// person's notes are mirrored, and which credentials do it, is their decision
// about their own data. Every route below is scoped to the caller, so there is
// no path through Papyra for one account to read or configure another's.
// The token is stored in the clear (git auth needs the raw PAT) and never
// returned; the read shows only whether one is set, plus last-sync status.
var gitApi = app.MapGroup("/api/git").RequireAuthorization().WithTags("Git");

gitApi.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = Uid(user);
    var prefix = GitKeys.Prefix(uid);
    var settings = await db.Settings
        .Where(s => s.Key.StartsWith(prefix))
        .ToDictionaryAsync(s => s.Key, s => s.Value, ct);
    string? Get(string k) => settings.GetValueOrDefault(k);
    return Results.Ok(new
    {
        remoteUrl = Get(GitKeys.RemoteUrl(uid)) ?? string.Empty,
        branch = string.IsNullOrWhiteSpace(Get(GitKeys.Branch(uid))) ? "main" : Get(GitKeys.Branch(uid)),
        hasToken = !string.IsNullOrEmpty(Get(GitKeys.Token(uid))),
        conflict = Get(GitKeys.Conflict(uid)) == "true",
        lastSyncUtc = string.IsNullOrEmpty(Get(GitKeys.LastSyncUtc(uid))) ? null : Get(GitKeys.LastSyncUtc(uid)),
        lastError = string.IsNullOrEmpty(Get(GitKeys.LastError(uid))) ? null : Get(GitKeys.LastError(uid)),
        mode = Get(GitKeys.Mode(uid)) == "encrypted" ? "encrypted" : "plain",
    });
});

gitApi.MapPut("/", async (
    GitConfigWrite body, ClaimsPrincipal user, AppDbContext db, GitSyncService git,
    IConfiguration config, IHostEnvironment env, LoginThrottle throttle, CancellationToken ct) =>
{
    var uid = Uid(user);
    var remote = body.RemoteUrl?.Trim() ?? string.Empty;
    if (remote.Length > 0 && !Uri.TryCreate(remote, UriKind.Absolute, out _))
        return Results.BadRequest(new { error = "The remote must be a full URL, for example https://github.com/you/notes.git" });
    var branchName = string.IsNullOrWhiteSpace(body.Branch) ? "main" : body.Branch.Trim();
    var current = await db.Settings.Where(s => s.Key.StartsWith(GitKeys.Prefix(uid))).ToDictionaryAsync(s => s.Key, s => s.Value, ct);
    var wasEncrypted = current.GetValueOrDefault(GitKeys.Mode(uid)) == "encrypted" && !string.IsNullOrEmpty(current.GetValueOrDefault(GitKeys.DataKey(uid)));
    var wantEncrypted = body.Mode is null ? wasEncrypted : body.Mode == "encrypted";
    if (body.Mode is not (null or "plain" or "encrypted"))
        return Results.BadRequest(new { error = "Backup mode is plain or encrypted." });

    // Turning encryption on seals a fresh data key under the account password,
    // so that password is what a restore will ask for.
    string? newKey = null, newHeader = null;
    if (wantEncrypted && !wasEncrypted)
    {
        var me = await db.Users.FindAsync([int.Parse(uid)], ct);
        if (me is null) return Results.NotFound();
        var lockKey = $"git-encrypt:{uid}";
        if (throttle.IsLockedOut(lockKey)) return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: 429);
        if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, me.PasswordHash))
        {
            if (!string.IsNullOrEmpty(body.Password)) throttle.RecordFailure(lockKey);
            return Results.Json(new { error = "Enter your account password to turn on encryption — it is what unlocks the backup.", field = "password" },
                statusCode: StatusCodes.Status401Unauthorized);
        }
        throttle.Reset(lockKey);
        var dataKey = EncryptedGitCodec.NewDataKey();
        try
        {
            newKey = git.ProtectKey(dataKey);
            newHeader = System.Text.Json.JsonSerializer.Serialize(EncryptedGitCodec.Wrap(dataKey, body.Password), GitSyncService.JsonOpts);
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(dataKey); }
    }

    // A different repository (or branch) starts a new local mirror, or the old
    // one's history would be pushed somewhere it never belonged.
    if (!string.Equals(current.GetValueOrDefault(GitKeys.RemoteUrl(uid)) ?? string.Empty, remote, StringComparison.Ordinal)
        || !string.Equals(current.GetValueOrDefault(GitKeys.Branch(uid)) ?? "main", branchName, StringComparison.Ordinal))
    {
        var mirror = PapyraPaths.UserGitMirrorDir(config, env.ContentRootPath, uid);
        if (Directory.Exists(mirror)) DeleteDirectoryForce(mirror);
    }

    async Task Set(string key, string value)
    {
        var row = await db.Settings.FindAsync([key], ct);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
    }

    await Set(GitKeys.RemoteUrl(uid), remote);
    await Set(GitKeys.Branch(uid), branchName);
    // Only overwrite the token when one is supplied, so saving config doesn't wipe it.
    if (body.Token is not null) await Set(GitKeys.Token(uid), body.Token.Trim());
    await Set(GitKeys.Mode(uid), wantEncrypted ? "encrypted" : "plain");
    if (newKey is not null) { await Set(GitKeys.DataKey(uid), newKey); await Set(GitKeys.Crypto(uid), newHeader!); }
    if (!wantEncrypted) { await Set(GitKeys.DataKey(uid), string.Empty); await Set(GitKeys.Crypto(uid), string.Empty); }
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
})
    .WithSummary("Configure git backup of your own vault")
    .WithDescription(
        "Sets the remote for a mirror of the caller's vault only. Papyra's own state "
        + "(.papyra/, .trash/) is gitignored. Each account has its own repository and "
        + "its own credentials; no account can configure or trigger another's.");

// The guided setup's "Check the connection" step: try the address and token
// before anything is saved, and say in plain words what's wrong. A stored token
// is used when none is typed, so re-checking an existing setup needs no retyping.
gitApi.MapPost("/test", async (GitConfigWrite body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var remote = body.RemoteUrl?.Trim() ?? string.Empty;
    if (!Uri.TryCreate(remote, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
        return Results.BadRequest(new { error = "Paste the repository's https address, e.g. https://github.com/you/papyra-notes.git" });
    var tokenKey = GitKeys.Token(Uid(user));
    var token = string.IsNullOrWhiteSpace(body.Token)
        ? (await db.Settings.FirstOrDefaultAsync(s => s.Key == tokenKey, ct))?.Value
        : body.Token.Trim();
    var (problem, branches) = await Task.Run(() => GitSyncService.Probe(remote, token), ct);
    return problem is null
        ? Results.Ok(new { ok = true, empty = branches.Count == 0, branches })
        : Results.Ok(new { ok = false, error = problem });
})
    .RequireRateLimiting(AuthRateLimit)
    .WithSummary("Check a git remote and token without saving them");

gitApi.MapPost("/sync", async (ClaimsPrincipal user, GitSyncService git, CancellationToken ct) =>
{
    var result = await git.SyncOnceAsync(Uid(user), ct);
    return Results.Ok(new { result.Status, result.Detail });
})
    .WithSummary("Back up your vault now")
    .WithDescription(
        "Stages, commits and pushes the caller's vault. Returns status 'pushed', "
        + "'clean', or 'conflict' — a diverged remote is never force-pushed; the "
        + "conflict flag is raised instead and the remote is left untouched.");

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
notes.MapGet("/{id}/snapshots", async (
    string id,
    ClaimsPrincipal user,
    VaultState state,
    SnapshotService snapshots,
    VaultObserverOptions vault,
    AppDbContext db,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    var logger = loggerFactory.CreateLogger("PathGuard");
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var dir = PathGuard.ResolveAndVerify(snapRoot, id, logger);
    // Distinct versions only, and none identical to the live note (see List).
    var live = state.PathFor(uid, id)
        ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(uid), $"{id}.md", logger);
    var versions = snapshots.List(dir, live);

    // Versions written by a live room carry who edited them ("edited by A, B").
    var editors = versions.ToDictionary(v => v.Id, v => snapshots.ContributorsOf(dir, v.Id));
    var uids = editors.Values.SelectMany(u => u).Distinct().ToList();
    var names = uids.Count == 0
        ? new Dictionary<int, string>()
        : await db.Users.Where(u => uids.Contains(u.Id))
            .Select(u => new { u.Id, u.Name, u.Username })
            .ToDictionaryAsync(u => u.Id, u => string.IsNullOrWhiteSpace(u.Name) ? u.Username : u.Name, ct);
    return Results.Ok(versions.Select(v => new
    {
        id = v.Id,
        timestamp = v.TimestampUtc,
        editors = editors[v.Id].Where(names.ContainsKey).Select(u => names[u]).ToArray(),
    }));
});

notes.MapGet("/{id}/snapshots/{snapshotId}", async (
    string id,
    string snapshotId,
    ClaimsPrincipal user,
    MarkdownStorageService storage,
    VaultState state,
    HttpContext http,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory loggerFactory,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
    var logger = loggerFactory.CreateLogger("PathGuard");
    var snapPath = PathGuard.ResolveAndVerify(snapRoot, Path.Combine(id, $"{snapshotId}.md"), logger);

    var note = await storage.ReadAsync(snapPath, ct);
    if (note is null) return Results.NotFound();
    // An old revision of a secure note is the note: same gate as /secure. So is a
    // plain revision of a note that has since been locked — it holds what the
    // owner has since chosen to lock away.
    if ((note.Secure || IsSecureNow(state, uid, id)) && !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock required.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);
    return Results.Ok(note);
});

notes.MapPost("/{id}/restore/{snapshotId}", async (
    string id,
    string snapshotId,
    ClaimsPrincipal user,
    HttpContext http,
    VaultState state,
    MarkdownStorageService storage,
    SnapshotService snapshots,
    WriteRing writeRing,
    SearchIndexService search,
    VaultObserverOptions vault,
    ICollabEngine collab,
    CollabStateStore collabStates,
    NoteWriteLocks writeLocks,
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

    // Restoring can swap a secure note for an older, unlocked revision — taking the
    // lock off without the vault — and the response carries the body. Gate it.
    var snapshot = await storage.ReadAsync(snapPath, ct);
    if ((snapshot?.Secure == true || IsSecureNow(state, uid, id)) && !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock required.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);

    var path = state.PathFor(uid, id)
        ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(uid), $"{id}.md", logger);

    // Archive the current revision first so the restore itself is reversible, then
    // atomically swap the snapshot in. Log the self-write so the watcher ignores it.
    // Forced past the throttle: a restore minutes after the last snapshot used to
    // skip the archive, and the version it replaced was simply gone.
    var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, logger);

    // Someone editing this note live: save what they have typed first, so the
    // version this restore replaces (and its undo) holds it. The room itself
    // is then told to *replace* its text — a restore is never merged.
    var liveRoom = await collab.IsRoomActiveAsync(uid, id, ct);
    if (liveRoom) await collab.FlushAsync(uid, id, ct);

    Note? note;
    string? undoId;
    using (await writeLocks.AcquireAsync(uid, id, ct))
    {
        undoId = await snapshots.CaptureAsync(noteSnapDir, path, ct, force: true);
        await collabStates.AttributeSnapshotAsync(snapshots, uid, id, noteSnapDir, undoId, ct);

        writeRing.Mark(path);
        await snapshots.RestoreAsync(snapPath, path, ct);

        note = await storage.ReadAsync(path, ct);
        if (note is null) return Results.NotFound();
        // The restored file is this note, whatever the archived copy's frontmatter
        // says. A copy without an `id` (a file last written by another editor) would
        // otherwise come back as an id-less note the vault ignores — the note would
        // simply vanish from the app after a restore.
        if (note.Id != id)
        {
            note.Id = id;
            writeRing.Mark(path);
            await storage.WriteAsync(path, note, ct);
            note = await storage.ReadAsync(path, ct) ?? note;
        }
        state.Upsert(uid, path, note);
        search.IndexNote(uid, note);
    }
    if (liveRoom) await collab.RestoreAsync(uid, id, note.Body, ct);
    // The version that holds what was just replaced — restoring it undoes this.
    if (undoId is not null) http.Response.Headers["Papyra-Undo-Snapshot"] = undoId;
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
    HttpContext http,
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

    // A sync conflict of a secure note carries two copies of its body.
    if ((parentNote?.Secure == true || conflictNote.Secure) && !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock required.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);

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
            // resolver is for. Forced past the throttle, like restore: a snapshot a few
            // minutes old would otherwise mean the replaced text is never archived.
            if (keep == "right")
            {
                var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
                var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, c.ParentId, logger);
                await snapshots.CaptureAsync(noteSnapDir, targetPath, ct, force: true);
            }

            writeRing.Mark(targetPath); // our write — watcher ignores the echo
            await storage.WriteAsync(targetPath, copy, ct);
            state.Upsert(uid, targetPath, copy);
            search.IndexNote(uid, copy);
            await hub.Clients.User(uid).SendAsync(keep == "right" ? "NoteUpdated" : "NoteCreated", NoteMetadata.From(copy), ct);
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

    await hub.Clients.User(uid).SendAsync("ConflictResolved", new { id, parentId = c.ParentId }, ct);
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
notes.MapPost("/{id}/shares", async (
    string id, ShareWrite body, ClaimsPrincipal user, AppDbContext db,
    VaultState state, MarkdownStorageService storage, VaultObserverOptions vault,
    IHubContext<NotesHub> hub, EmailSender email, HttpContext http,
    ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var kind = body.Kind?.Trim().ToLowerInvariant();
    var access = body.Access?.Trim().ToLowerInvariant() == "edit" ? "edit" : "view";
    if (kind is not ("link" or "user")) return Results.BadRequest(new { error = "kind must be link or user." });

    // A locked note's body is withheld from every other read path until a
    // biometric unlock. A share is another read path, so this is where that
    // promise would otherwise be worth nothing.
    var subject = await storage.ReadAsync(OwnerNotePath(state, vault, lf, uid.ToString(), id), ct);
    if (subject?.Secure == true)
        return Results.BadRequest(new { error = "This note is locked. Unlock it before sharing it." });

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

        // Sharing with someone who already has this note is not an error, and it
        // must not pile up rows — mentioning the same person twice would
        // otherwise leave two grants for one piece of access, and revoking one
        // would look like it did nothing.
        var existing = await db.Shares.FirstOrDefaultAsync(
            x => x.OwnerId == uid && x.NoteId == id && x.Kind == "user" && x.GranteeUserId == grantee.Id, ct);
        if (existing is not null)
        {
            // Upgrade view to edit if that is what was asked for; never quietly
            // downgrade, since that would silently take access away.
            if (access == "edit" && existing.Access != "edit")
            {
                existing.Access = "edit";
                await SettleAccessRequests(db, uid, id, grantee.Id, "edit", ct);
                await db.SaveChangesAsync(ct);
                await AnnounceShare(db, hub, email, http, grantee, user, uid, id, subject?.Title, "edit", "access_upgraded", ct);
            }
            return Results.Ok(new { existing.Id, existing.Kind, existing.Access, existing.Token, existing.ExpiresUtc, existing.MaxViews });
        }
    }
    else
    {
        var raw = System.Security.Cryptography.RandomNumberGenerator.GetBytes(24);
        share.Token = Convert.ToBase64String(raw).Replace("+", "").Replace("/", "").Replace("=", "");
    }

    db.Shares.Add(share);
    if (share.GranteeUserId is { } gid) await SettleAccessRequests(db, uid, id, gid, access, ct);
    await db.SaveChangesAsync(ct);
    if (share.GranteeUserId is { } granteeId && await db.Users.FindAsync([granteeId], ct) is { } recipient)
        await AnnounceShare(db, hub, email, http, recipient, user, uid, id, subject?.Title, access, "shared", ct);
    return Results.Ok(new { share.Id, share.Kind, share.Access, share.Token, share.ExpiresUtc, share.MaxViews });
});

// Owner: revoke any of their own shares.
var shares = app.MapGroup("/api/shares").RequireAuthorization().WithTags("Sharing");

shares.MapDelete("/{shareId:int}", async (
    int shareId, ClaimsPrincipal user, AppDbContext db, IHubContext<NotesHub> hub, ICollabEngine collab,
    CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.OwnerId == uid, ct);
    if (share is null) return Results.NotFound();
    db.Shares.Remove(share);
    await db.SaveChangesAsync(ct);
    // The grantee's rail and any open copy of the note have to let go now, not
    // on their next reload.
    if (share.GranteeUserId is { } gone)
    {
        await hub.Clients.User(gone.ToString()).SendAsync("SharesChanged", ct);
        // ...and out of the live room, if they are in it (their open ticket is void too).
        await collab.KickAsync(share.OwnerId.ToString(), share.NoteId, gone, ct);
    }
    return Results.NoContent();
});

// Owner: share a selection of notes with one person. Same rules as the per-note
// share — locked notes refuse, an existing grant is reused (upgraded to edit if
// asked, never downgraded) — with a verdict per note: "shared", "upgraded",
// "alreadyShared", "locked", or "notFound" (not yours, gone, or in Trash).
shares.MapPost("/bulk", async (
    BulkShareWrite body, ClaimsPrincipal user, AppDbContext db, VaultState state,
    IHubContext<NotesHub> hub, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var access = body.Access?.Trim().ToLowerInvariant() == "edit" ? "edit" : "view";
    var ids = (body.NoteIds ?? []).Where(i => !string.IsNullOrWhiteSpace(i)).Distinct(StringComparer.Ordinal).ToList();
    if (ids.Count == 0) return Results.BadRequest(new { error = "No notes selected." });
    if (ids.Count > BulkNoteAction.MaxIds)
        return Results.BadRequest(new { error = $"Select at most {BulkNoteAction.MaxIds} notes at a time." });

    var uname = body.GranteeUsername?.Trim();
    if (string.IsNullOrWhiteSpace(uname)) return Results.BadRequest(new { error = "Who should these be shared with?" });
    var grantee = await db.Users.FirstOrDefaultAsync(u => u.Username == uname, ct);
    if (grantee is null) return Results.NotFound(new { error = $"There's no one called “{uname}” here." });
    if (grantee.Id == uid) return Results.BadRequest(new { error = "These are already yours." });

    var existing = await db.Shares
        .Where(s => s.OwnerId == uid && s.Kind == "user" && s.GranteeUserId == grantee.Id && ids.Contains(s.NoteId))
        .ToDictionaryAsync(s => s.NoteId, ct);

    var results = new List<object>(ids.Count);
    var shared = 0;
    foreach (var id in ids)
    {
        var path = state.PathFor(uid.ToString(), id);
        if (path is null || !state.TryGet(uid.ToString(), path, out var note) || note is null || note.Trashed)
        {
            results.Add(new { id, status = "notFound" });
            continue;
        }
        if (note.Secure)
        {
            results.Add(new { id, status = "locked" });
            continue;
        }
        if (existing.TryGetValue(id, out var have))
        {
            if (access == "edit" && have.Access != "edit")
            {
                have.Access = "edit";
                await SettleAccessRequests(db, uid, id, grantee.Id, "edit", ct);
                db.Notifications.Add(new Notification
                {
                    UserId = grantee.Id, Kind = "access_upgraded", ActorUserId = uid, OwnerId = uid,
                    NoteId = id, Access = "edit", CreatedUtc = DateTime.UtcNow,
                });
                results.Add(new { id, status = "upgraded" });
                shared++;
            }
            else results.Add(new { id, status = "alreadyShared" });
            continue;
        }

        db.Shares.Add(new Share
        {
            NoteId = id, OwnerId = uid, Kind = "user", Access = access,
            GranteeUserId = grantee.Id, CreatedUtc = DateTime.UtcNow,
        });
        await SettleAccessRequests(db, uid, id, grantee.Id, access, ct);
        db.Notifications.Add(new Notification
        {
            UserId = grantee.Id, Kind = "shared", ActorUserId = uid, OwnerId = uid,
            NoteId = id, Access = access, CreatedUtc = DateTime.UtcNow,
        });
        results.Add(new { id, status = "shared" });
        shared++;
    }

    await db.SaveChangesAsync(ct);
    if (shared > 0)
    {
        await hub.Clients.User(grantee.Id.ToString()).SendAsync("SharesChanged", ct);
        await hub.Clients.User(grantee.Id.ToString()).SendAsync("NotificationsChanged", ct);
    }
    return Results.Ok(new { grantee = grantee.Username, shared, results });
})
.WithSummary("Share many notes with one person");

// Owner: who can see what, across every note at once.
//
// A card in the grid has to be able to say "shared with 2 people" without asking
// per note — that is one request per card on a screen full of them. This is the
// whole picture in a single query, keyed by note id, and it carries names rather
// than only counts so the detail on hover needs no second trip.
shares.MapGet("/summary", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.Shares.Where(s => s.OwnerId == uid).ToListAsync(ct);
    if (rows.Count == 0) return Results.Ok(Array.Empty<object>());

    var granteeIds = rows.Where(s => s.GranteeUserId != null).Select(s => s.GranteeUserId!.Value).ToHashSet();
    var names = await db.Users.Where(u => granteeIds.Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => u.Username, ct);

    var summary = rows
        .GroupBy(s => s.NoteId)
        .Select(g => new
        {
            noteId = g.Key,
            people = g.Where(s => s.Kind == "user" && s.GranteeUserId is not null)
                .Select(s => names.GetValueOrDefault(s.GranteeUserId!.Value, "?"))
                .OrderBy(n => n)
                .ToArray(),
            // Link shares have no name to show, so they are counted. A live one is
            // a standing key to the note, which is worth saying out loud even
            // when nobody has been named.
            links = g.Count(s => s.Kind == "link"
                && (s.ExpiresUtc is null || s.ExpiresUtc > DateTime.UtcNow)
                && (s.MaxViews is null || s.ViewCount < s.MaxViews)),
        })
        .ToArray();

    return Results.Ok(summary);
});

// Grantee: notes shared *with me* by other users.
shares.MapGet("/incoming", async (
    ClaimsPrincipal user, AppDbContext db, VaultState state, MarkdownStorageService storage,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.Shares.Where(s => s.GranteeUserId == uid && s.Kind == "user")
        .OrderByDescending(s => s.CreatedUtc).ToListAsync(ct);
    var ownerNames = await db.Users.Where(u => rows.Select(r => r.OwnerId).Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => u.Username, ct);
    // Asked-for-edit shares render "Requested" instead of the button again.
    var pending = (await db.AccessRequests
            .Where(r => r.RequesterUserId == uid && r.Status == "pending")
            .Select(r => new { r.OwnerId, r.NoteId })
            .ToListAsync(ct))
        .Select(r => (r.OwnerId, r.NoteId)).ToHashSet();

    var result = new List<object>();
    foreach (var s in rows)
    {
        var note = await storage.ReadAsync(OwnerNotePath(state, vault, lf, s.OwnerId.ToString(), s.NoteId), ct);
        // Locking a note is a decision made after the share, and it has to win:
        // the owner's later "nobody sees this" outranks their earlier "you can".
        if (note?.Secure == true) continue;
        result.Add(new
        {
            shareId = s.Id, noteId = s.NoteId, access = s.Access,
            owner = ownerNames.GetValueOrDefault(s.OwnerId, "?"),
            title = note?.Title ?? string.Empty,
            // A short plain-text taste of the note so the card is recognisable
            // without opening it — the sharee may read all of it anyway.
            excerpt = note is null ? string.Empty : ShareExcerpt(note.Body),
            // The card previews the note exactly as the owner's own card does;
            // the sharee is entitled to all of it.
            body = note?.Body ?? string.Empty,
            color = note?.Color,
            updatedUtc = note?.Updated,
            // When it was shared with you — the Shared with me page says so.
            sharedUtc = DateTime.SpecifyKind(s.CreatedUtc, DateTimeKind.Utc),
            requestPending = pending.Contains((s.OwnerId, s.NoteId)),
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
    // Locked since it was shared: the body stays in the owner's vault. Reported
    // as gone rather than forbidden — the sharee has no way to unlock it, so
    // "come back with credentials" would be advice they cannot take.
    if (note.Secure) return Results.Json(
        new { error = "The owner locked this note." }, statusCode: StatusCodes.Status410Gone);
    var requestPending = share.Access != "edit" && await db.AccessRequests.AnyAsync(
        r => r.RequesterUserId == uid && r.OwnerId == share.OwnerId && r.NoteId == share.NoteId
             && r.Status == "pending", ct);
    return Results.Ok(new
    {
        note.Title, note.Body, note.Color, access = share.Access,
        owner = await db.Users.Where(u => u.Id == share.OwnerId).Select(u => u.Username).FirstOrDefaultAsync(ct),
        requestPending,
    });
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
    IHubContext<NotesHub> hub, VaultObserverOptions vault, ILoggerFactory lf, ICollabEngine collab, NoteWriteLocks writeLocks, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
    if (share is null) return Results.NotFound();
    if (share.Access != "edit") return Results.Forbid();
    return await ApplySharedEdit(share.OwnerId.ToString(), share.NoteId, body.Body ?? string.Empty,
        state, storage, writeRing, search, snapshots, config, env, hub, vault, lf, collab, writeLocks, ct);
});

// ── Notifications (the bell) ─────────────────────────────────────────────────
// Everything that happened to the caller involving someone else: mentions,
// shares, edit-access upgrades, access requests on their notes and the answers
// to their own requests. Each entry is resolved against live state on read — a
// note's title or mentioning line is shown only to its owner or a sharee, and a
// request's actions only while it is still pending.
var notifications = app.MapGroup("/api/notifications").RequireAuthorization().WithTags("Notifications");

notifications.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, VaultState state, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.Notifications
        .Where(n => n.UserId == uid && n.DismissedUtc == null)
        .OrderByDescending(n => n.CreatedUtc).ThenByDescending(n => n.Id)
        .Take(100)
        .ToListAsync(ct);
    if (rows.Count == 0) return Results.Ok(Array.Empty<object>());

    var actorIds = rows.Select(n => n.ActorUserId).ToHashSet();
    var actors = await db.Users.Where(u => actorIds.Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => new { u.Username, u.Name }, ct);
    var myShares = (await db.Shares.Where(s => s.GranteeUserId == uid && s.Kind == "user")
            .Select(s => new { s.Id, s.OwnerId, s.NoteId, s.Access }).ToListAsync(ct))
        .ToDictionary(s => (s.OwnerId, s.NoteId));
    var requestIds = rows.Where(n => n.AccessRequestId != null).Select(n => n.AccessRequestId!.Value).ToHashSet();
    var requests = await db.AccessRequests.Where(r => requestIds.Contains(r.Id))
        .ToDictionaryAsync(r => r.Id, ct);
    var myPending = (await db.AccessRequests.Where(r => r.RequesterUserId == uid && r.Status == "pending")
            .Select(r => new { r.OwnerId, r.NoteId }).ToListAsync(ct))
        .Select(r => (r.OwnerId, r.NoteId)).ToHashSet();
    var grantIds = rows.Where(n => n.BlockGrantId != null).Select(n => n.BlockGrantId!.Value).ToHashSet();
    var grants = await db.BlockGrants.Where(g => grantIds.Contains(g.Id)).ToDictionaryAsync(g => g.Id, ct);

    var result = rows.Select(n =>
    {
        var ownerUid = n.OwnerId.ToString();
        var path = state.PathFor(ownerUid, n.NoteId);
        Note? note = null;
        if (path is not null) state.TryGet(ownerUid, path, out note);
        var available = note is not null && !note.Secure && !note.Trashed;
        myShares.TryGetValue((n.OwnerId, n.NoteId), out var share);
        var mine = n.OwnerId == uid;
        var visible = available && (mine || share is not null);

        string? text = null;
        if (visible && n.Kind == "mention" && n.BlockGrantId is { } gid && grants.TryGetValue(gid, out var g))
            text = g.BlockId.Length > 0
                ? BlockResolver.Resolve(note!.Body, g.BlockId)
                : BlockResolver.ResolveLine(note!.Body, g.BlockText);

        var request = n.AccessRequestId is { } rid ? requests.GetValueOrDefault(rid) : null;
        var actor = actors.GetValueOrDefault(n.ActorUserId);
        return new
        {
            n.Id, n.Kind, n.CreatedUtc, n.ReadUtc, n.NoteId, n.Access,
            actor = actor?.Username ?? "someone",
            actorName = actor?.Name,
            title = visible ? note!.Title : null,
            text,
            available,
            mine,
            shareId = share?.Id,
            shareAccess = share?.Access,
            requestId = n.AccessRequestId,
            requestStatus = request?.Status,
            requestPending = myPending.Contains((n.OwnerId, n.NoteId)),
        };
    });
    return Results.Ok(result);
})
.WithSummary("List my notifications");

notifications.MapPost("/read", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var now = DateTime.UtcNow;
    var marked = await db.Notifications
        .Where(n => n.UserId == uid && n.DismissedUtc == null && n.ReadUtc == null)
        .ExecuteUpdateAsync(x => x.SetProperty(n => n.ReadUtc, now), ct);
    // Opening the tray is also looking at the mentions the old inbox badge counted.
    await db.BlockGrants
        .Where(g => g.GranteeUserId == uid && g.DismissedUtc == null && g.ReadUtc == null)
        .ExecuteUpdateAsync(x => x.SetProperty(g => g.ReadUtc, now), ct);
    return Results.Ok(new { marked });
})
.WithSummary("Mark all notifications read");

notifications.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var n = await db.Notifications.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
    if (n is null) return Results.NotFound();
    n.DismissedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
})
.WithSummary("Dismiss a notification");

// ── Access requests ────────────────────────────────────────────────────────────
// "Request access" / "Request edit access", as in Google Docs: someone who can
// see that a note exists — through a read-only share, or because they were
// mentioned in it — asks its owner for access; the owner approves (as viewer or
// editor) or declines from their inbox. A request is never a way to discover a
// note: it must be anchored to a share or mention the requester already holds.
var accessRequests = app.MapGroup("/api/access-requests").RequireAuthorization().WithTags("Sharing");

accessRequests.MapPost("/", async (
    AccessRequestWrite body, ClaimsPrincipal user, AppDbContext db, VaultState state,
    IHubContext<NotesHub> hub, EmailSender email, HttpContext http, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var access = body.Access?.Trim().ToLowerInvariant() == "view" ? "view" : "edit";

    int ownerId; string noteId;
    if (body.ShareId is { } shareId)
    {
        var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
        if (share is null) return Results.NotFound();
        (ownerId, noteId) = (share.OwnerId, share.NoteId);
    }
    else if (body.InboxId is { } inboxId)
    {
        var grant = await db.BlockGrants.FirstOrDefaultAsync(
            g => g.Id == inboxId && g.GranteeUserId == uid && g.DismissedUtc == null, ct);
        if (grant is null) return Results.NotFound();
        (ownerId, noteId) = (grant.SourceOwnerId, grant.SourceNoteId);
    }
    else if (body.NotificationId is { } notificationId)
    {
        // A notification the caller received (a mention, a declined request)
        // is proof they were told this note exists.
        var told = await db.Notifications.FirstOrDefaultAsync(
            n => n.Id == notificationId && n.UserId == uid && n.OwnerId != uid, ct);
        if (told is null) return Results.NotFound();
        (ownerId, noteId) = (told.OwnerId, told.NoteId);
    }
    else return Results.BadRequest(new { error = "Say which shared note or inbox entry this is about." });

    // Gone, or locked since: nothing to grant. Same 404 as "not yours", so this
    // cannot be used to tell the two apart.
    var ownerUid = ownerId.ToString();
    var path = state.PathFor(ownerUid, noteId);
    if (path is null || !state.TryGet(ownerUid, path, out var note) || note is null || note.Trashed)
        return Results.NotFound();
    if (note.Secure) return Results.Json(new { error = "The owner locked this note." }, statusCode: StatusCodes.Status410Gone);

    var held = await db.Shares.FirstOrDefaultAsync(
        s => s.OwnerId == ownerId && s.NoteId == noteId && s.Kind == "user" && s.GranteeUserId == uid, ct);
    if (held is not null && (held.Access == "edit" || access == "view"))
        return Results.Conflict(new { error = "You already have that access." });

    // One open request per person per note. Asking again while one is pending
    // is not an error — it is the same request — and must not ping the owner twice.
    var open = await db.AccessRequests.FirstOrDefaultAsync(
        r => r.OwnerId == ownerId && r.NoteId == noteId && r.RequesterUserId == uid && r.Status == "pending", ct);
    if (open is not null)
    {
        if (access == "edit" && open.Access != "edit") { open.Access = "edit"; await db.SaveChangesAsync(ct); }
        return Results.Ok(new { open.Id, open.Access, open.Status });
    }

    var request = new AccessRequest
    {
        OwnerId = ownerId, NoteId = noteId, RequesterUserId = uid, Access = access,
        Status = "pending", CreatedUtc = DateTime.UtcNow,
    };
    db.AccessRequests.Add(request);
    await db.SaveChangesAsync(ct);
    db.Notifications.Add(new Notification
    {
        UserId = ownerId, Kind = "access_requested", ActorUserId = uid, OwnerId = ownerId,
        NoteId = noteId, Access = access, AccessRequestId = request.Id, CreatedUtc = request.CreatedUtc,
    });
    await db.SaveChangesAsync(ct);

    await hub.Clients.User(ownerUid).SendAsync("AccessRequested", new { request.Id }, ct);
    await hub.Clients.User(ownerUid).SendAsync("NotificationsChanged", ct);
    var owner = await db.Users.FindAsync([ownerId], ct);
    if (owner is not null && NotificationPrefs.Wants(owner, NotificationCatalog.AccessRequested) && email.IsConfigured)
    {
        var who = await db.Users.Where(u => u.Id == uid).Select(u => u.Username).FirstOrDefaultAsync(ct);
        var url = email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}");
        var verb = access == "edit" ? "edit" : "view";
        var name = string.IsNullOrWhiteSpace(note.Title) ? "Untitled" : note.Title;
        await email.NotifyAsync(owner, NotificationCatalog.AccessRequested,
            $"@{who} is asking to {verb} a note",
            $"@{who} asked for {verb} access to “{name}”.\n\n"
            + $"Approve or decline it in Papyra: {url}/?notifications=1",
            ct: ct);
    }
    return Results.Ok(new { request.Id, request.Access, request.Status });
})
.WithSummary("Ask a note's owner for access");

// Owner: requests waiting on a decision, newest first.
accessRequests.MapGet("/incoming", async (ClaimsPrincipal user, AppDbContext db, VaultState state, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.AccessRequests.Where(r => r.OwnerId == uid && r.Status == "pending")
        .OrderByDescending(r => r.CreatedUtc).ToListAsync(ct);
    var ids = rows.Select(r => r.RequesterUserId).ToHashSet();
    var people = await db.Users.Where(u => ids.Contains(u.Id))
        .ToDictionaryAsync(u => u.Id, u => new { u.Username, u.Name }, ct);

    var result = new List<object>();
    foreach (var r in rows)
    {
        var path = state.PathFor(uid.ToString(), r.NoteId);
        Note? note = null;
        if (path is not null) state.TryGet(uid.ToString(), path, out note);
        // A request for a note since deleted is moot; leave it out rather than
        // offering to share something that isn't there.
        if (note is null || note.Trashed) continue;
        var who = people.GetValueOrDefault(r.RequesterUserId);
        var current = await db.Shares.Where(s => s.OwnerId == uid && s.NoteId == r.NoteId
                && s.Kind == "user" && s.GranteeUserId == r.RequesterUserId)
            .Select(s => s.Access).FirstOrDefaultAsync(ct);
        result.Add(new
        {
            r.Id, r.NoteId, r.Access, r.CreatedUtc,
            title = note.Title,
            requester = who?.Username ?? "?",
            requesterName = who?.Name,
            currentAccess = current,
        });
    }
    return Results.Ok(result);
})
.WithSummary("Access requests waiting on me");

// Owner: approve — creates or upgrades the share. `access` lets the owner grant
// less than was asked for (view instead of edit); never a downgrade of a share
// the requester already holds.
accessRequests.MapPost("/{id:int}/approve", async (
    int id, AccessDecision? body, ClaimsPrincipal user, AppDbContext db, VaultState state,
    IHubContext<NotesHub> hub, EmailSender email, HttpContext http, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var request = await db.AccessRequests.FirstOrDefaultAsync(r => r.Id == id && r.OwnerId == uid, ct);
    if (request is null) return Results.NotFound();
    if (request.Status != "pending") return Results.Conflict(new { error = "That request was already answered." });

    var path = state.PathFor(uid.ToString(), request.NoteId);
    if (path is null || !state.TryGet(uid.ToString(), path, out var note) || note is null || note.Trashed)
        return Results.NotFound(new { error = "That note no longer exists." });
    if (note.Secure) return Results.BadRequest(new { error = "This note is locked. Unlock it before sharing it." });

    var access = (body?.Access ?? request.Access).Trim().ToLowerInvariant() == "edit" ? "edit" : "view";
    var share = await db.Shares.FirstOrDefaultAsync(
        s => s.OwnerId == uid && s.NoteId == request.NoteId && s.Kind == "user" && s.GranteeUserId == request.RequesterUserId, ct);
    if (share is null)
    {
        share = new Share
        {
            NoteId = request.NoteId, OwnerId = uid, Kind = "user", Access = access,
            GranteeUserId = request.RequesterUserId, CreatedUtc = DateTime.UtcNow,
        };
        db.Shares.Add(share);
    }
    else if (access == "edit") share.Access = "edit";

    request.Status = "approved";
    request.ResolvedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);

    if (await db.Users.FindAsync([request.RequesterUserId], ct) is { } requester)
        await AnnounceShare(db, hub, email, http, requester, user, uid, request.NoteId, note.Title, share.Access, "access_approved", ct, request.Id);
    return Results.Ok(new { request.Id, request.Status, access = share.Access });
})
.WithSummary("Approve an access request");

accessRequests.MapPost("/{id:int}/deny", async (
    int id, ClaimsPrincipal user, AppDbContext db, IHubContext<NotesHub> hub, EmailSender email, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var request = await db.AccessRequests.FirstOrDefaultAsync(r => r.Id == id && r.OwnerId == uid, ct);
    if (request is null) return Results.NotFound();
    if (request.Status != "pending") return Results.Conflict(new { error = "That request was already answered." });
    request.Status = "denied";
    request.ResolvedUtc = DateTime.UtcNow;
    db.Notifications.Add(new Notification
    {
        UserId = request.RequesterUserId, Kind = "access_denied", ActorUserId = uid, OwnerId = uid,
        NoteId = request.NoteId, Access = request.Access, AccessRequestId = request.Id,
        CreatedUtc = DateTime.UtcNow,
    });
    await db.SaveChangesAsync(ct);
    // The requester's button goes back to "Request", and their tray says so.
    await hub.Clients.User(request.RequesterUserId.ToString()).SendAsync("SharesChanged", ct);
    await hub.Clients.User(request.RequesterUserId.ToString()).SendAsync("NotificationsChanged", ct);
    // No title: a declined requester was never let into the note.
    if (await db.Users.FindAsync([request.RequesterUserId], ct) is { } requester)
        await email.NotifyAsync(requester, NotificationCatalog.AccessAnswered,
            $"@{user.Identity?.Name} declined your request",
            $"@{user.Identity?.Name} declined your request to see one of their notes. You can ask again later from the mention.",
            ct: ct);
    return Results.NoContent();
})
.WithSummary("Decline an access request");

// Public: read a link-shared note (enforces expiry + view cap, counts the view).
//
// A view is a visit, not a request. The first read hands the browser a signed,
// HttpOnly cookie scoped to this link; reads that carry it for the next hour
// don't count again and aren't refused. Without it a "view once" link died on
// its own first visit — anything that loaded the page twice (a reload, the
// service worker taking over, a remount) spent the only view. The cookie is
// Data-Protection-signed, so it can't be minted to dodge a limit, and it names
// the share and token, so it opens nothing else.
app.MapGet("/api/shared/{token}", async (
    string token, HttpContext http, IDataProtectionProvider dataProtection, AppDbContext db,
    VaultState state, MarkdownStorageService storage, EmailSender email,
    VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct) =>
{
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
    if (share is null) return Results.NotFound();
    if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
        return Results.Json(new { error = "This link has expired." }, statusCode: StatusCodes.Status410Gone);

    var viewer = dataProtection.CreateProtector("Papyra.SharedLinkView.v1").ToTimeLimitedDataProtector();
    var cookieName = $"papyra_view_{share.Id}";
    var visit = $"{share.Id}:{token}";
    var counted = false;
    if (http.Request.Cookies.TryGetValue(cookieName, out var cookie))
    {
        try { counted = viewer.Unprotect(cookie) == visit; }
        catch (System.Security.Cryptography.CryptographicException) { /* expired or forged: a new visit */ }
    }

    if (!counted && share.MaxViews is { } mv && share.ViewCount >= mv)
        return Results.Json(new { error = "This link has reached its view limit." }, statusCode: StatusCodes.Status410Gone);

    var note = await storage.ReadAsync(OwnerNotePath(state, vault, lf, share.OwnerId.ToString(), share.NoteId), ct);
    if (note is null) return Results.NotFound();
    if (note.Secure) return Results.Json(
        new { error = "The owner locked this note." }, statusCode: StatusCodes.Status410Gone);

    // Counted only once the note is actually being handed over, so a refused
    // read doesn't burn one of a limited-view link's views.
    if (!counted)
    {
        share.ViewCount++;
        await db.SaveChangesAsync(ct);
        var lifetime = TimeSpan.FromHours(1);
        http.Response.Cookies.Append(cookieName, viewer.Protect(visit, lifetime), new CookieOptions
        {
            HttpOnly = true,
            Secure = http.Request.IsHttps,
            SameSite = SameSiteMode.Strict,
            Path = $"/api/shared/{token}",
            MaxAge = lifetime,
        });
    }
    // Who is sharing it, and how many times the link has been opened (this
    // visit included) — the page says both, so a reader knows whose words these
    // are and how many views a limited link has left.
    var sharer = await db.Users.Where(u => u.Id == share.OwnerId)
        .Select(u => new { u.Username, u.Name }).FirstOrDefaultAsync(ct);
    return Results.Ok(new
    {
        note.Title, note.Body, note.Color, access = share.Access,
        // An anonymous reader has no roster to tell "@bea" on this Papyra from
        // "@bea" on another, so the handle carries the instance's domain —
        // usernames are unique per installation, the pair is unique everywhere.
        sharedBy = sharer is null ? null : new
        {
            sharer.Username, sharer.Name,
            handle = $"{sharer.Username}@{InstanceDomain(email, http)}",
        },
        views = share.ViewCount,
        maxViews = share.MaxViews,
    });
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
    VaultObserverOptions vault, ILoggerFactory lf, ICollabEngine collab, NoteWriteLocks writeLocks, CancellationToken ct) =>
{
    var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
    if (share is null) return Results.NotFound();
    if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
        return Results.Json(new { error = "This link has expired." }, statusCode: StatusCodes.Status410Gone);
    if (share.Access != "edit") return Results.Forbid();
    return await ApplySharedEdit(share.OwnerId.ToString(), share.NoteId, body.Body ?? string.Empty,
        state, storage, writeRing, search, snapshots, config, env, hub, vault, lf, collab, writeLocks, ct);
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
}).RequireAuthorization().RequireAiFeature(aiEnabled);

// ── Conversational RAG ────────────────────────────────────────────────────────
// Ask a question of your own notes. The prompt is embedded, the closest chunks are
// retrieved, and a local LLM answers grounded in them. Responds as newline-delimited
// JSON so the client can render citations immediately and stream the answer:
//   {"type":"citations", ...} → {"type":"token", ...}* → {"type":"done"}
// Secure notes are never embedded, so they can never be retrieved into an answer.
// Earlier turns handed to the model with a follow-up. Enough for "what about the
// second one?" to resolve, few enough that a long thread cannot crowd the notes
// out of the context window — the notes are what it is supposed to answer from.
const int AiChatHistoryTurns = 8;

app.MapPost("/api/ai/chat", async (
    AiChatRequest body, ClaimsPrincipal user, RagChatService rag, AiClient ai,
    AppDbContext db, HttpContext http, CancellationToken ct) =>
{
    var question = body.Question?.Trim();
    if (string.IsNullOrWhiteSpace(question))
        return Results.BadRequest(new { error = "A question is required." });

    var uid = int.Parse(Uid(user));

    // An existing thread must belong to the caller. Someone else's conversation
    // is a transcript of their notes, so this is the same boundary as the notes
    // themselves — a wrong id is "not found", never someone else's history.
    ChatSession? session = null;
    if (body.SessionId is { } sid)
    {
        session = await db.ChatSessions.FirstOrDefaultAsync(s => s.Id == sid && s.UserId == uid, ct);
        if (session is null) return Results.NotFound(new { error = "That conversation no longer exists." });
    }

    // Earlier turns, so a follow-up can say "the second one" and mean something.
    // Capped: the whole thread would eventually outgrow the model's context, and
    // the recent turns are the ones a follow-up refers to.
    var history = session is null
        ? []
        : await db.ChatMessages
            .Where(m => m.SessionId == session.Id)
            .OrderByDescending(m => m.Id)
            .Take(AiChatHistoryTurns)
            .Select(m => new ChatTurn(m.Role, m.Content))
            .ToListAsync(ct);
    history.Reverse();

    var citations = await rag.RetrieveAsync(Uid(user), question, ct);

    // Started here rather than after the answer: a conversation that the model
    // fails to answer is still a conversation the person had, and losing the
    // question they typed would be worse than an empty reply.
    //
    // The probe costs a request to the backend, so it happens at most once: a new
    // thread needs it to record what answered, and a failed answer needs it to
    // explain itself. A follow-up that works asks nothing extra.
    AiStatus? status = null;
    if (session is null)
    {
        status = await ai.ProbeAsync(ct);
        session = new ChatSession
        {
            UserId = uid,
            Title = ChatTitle(question),
            Model = status.ChatModel,
            Provider = status.ChatProvider,
        };
        db.ChatSessions.Add(session);
        await db.SaveChangesAsync(ct);
    }

    db.ChatMessages.Add(new ChatMessage { SessionId = session.Id, Role = "user", Content = question });
    session.UpdatedUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);

    http.Response.ContentType = "application/x-ndjson";
    var writer = new StreamWriter(http.Response.Body);

    // The session frame comes first so the panel can adopt a brand-new thread
    // before a single token arrives.
    await writer.WriteLineAsync(JsonSerializer.Serialize(new
    {
        type = "session",
        sessionId = session.Id,
        title = session.Title,
    }));
    await writer.WriteLineAsync(JsonSerializer.Serialize(new
    {
        type = "citations",
        citations = citations.Select(c => new { noteId = c.NoteId, title = c.Title, snippet = c.Snippet, score = c.Score }),
    }));
    await writer.FlushAsync(ct);

    var any = false;
    var answer = new System.Text.StringBuilder();
    await foreach (var token in rag.StreamAnswerAsync(question, citations, history, ct))
    {
        any = true;
        answer.Append(token);
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "token", value = token }));
        await writer.FlushAsync(ct); // flush per token so the UI streams
    }

    if (any)
    {
        db.ChatMessages.Add(new ChatMessage
        {
            SessionId = session.Id,
            Role = "assistant",
            Content = answer.ToString(),
            // What the answer was based on at the time. The note may since have
            // changed or gone; the citation is a record, not a live link.
            CitationsJson = JsonSerializer.Serialize(citations.Select(c => new
            {
                noteId = c.NoteId, title = c.Title, snippet = c.Snippet, score = c.Score,
            })),
        });
        session.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    // No tokens at all means the backend wasn't reachable. Ask it *why* and pass
    // that on — "no model is installed" and "your API key was rejected" need
    // different things from the user, and a bare "unavailable" tells them neither.
    string? failure = null;
    if (!any)
    {
        status ??= await ai.ProbeAsync(ct);
        // A configured-looking provider that still returns nothing is almost
        // always a rejected key or a model name that doesn't exist — neither of
        // which the probe can see without spending a request.
        failure = status.Reason
            ?? $"The {status.ChatProvider} backend accepted the request but returned nothing. "
             + "Check the API key and the model name in Settings → AI.";
    }

    await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "done", error = failure }));
    await writer.FlushAsync(ct);
    return Results.Empty;
}).RequireAuthorization().RequireAiFeature(aiEnabled);

// ── AI: conversations ─────────────────────────────────────────────────────────
// A person's conversations with the assistant are a transcript of their own
// notes, so every route here is scoped to the caller and a wrong id is "not
// found" rather than somebody else's thread.
var chats = app.MapGroup("/api/ai/sessions").RequireAuthorization().WithTags("AI").RequireAiFeature(aiEnabled);

chats.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var rows = await db.ChatSessions
        .Where(s => s.UserId == uid)
        .OrderByDescending(s => s.UpdatedUtc)
        .Select(s => new
        {
            s.Id,
            s.Title,
            s.Model,
            s.Provider,
            s.CreatedUtc,
            s.UpdatedUtc,
            messageCount = db.ChatMessages.Count(m => m.SessionId == s.Id),
        })
        .ToListAsync(ct);
    return Results.Ok(rows);
});

chats.MapGet("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var session = await db.ChatSessions.FirstOrDefaultAsync(s => s.Id == id && s.UserId == uid, ct);
    if (session is null) return Results.NotFound();

    var messages = await db.ChatMessages
        .Where(m => m.SessionId == id)
        .OrderBy(m => m.Id)
        .Select(m => new { m.Id, m.Role, m.Content, m.CitationsJson, m.CreatedUtc })
        .ToListAsync(ct);

    return Results.Ok(new
    {
        session.Id, session.Title, session.Model, session.Provider, session.UpdatedUtc,
        messages = messages.Select(m => new
        {
            m.Id, m.Role, m.Content, m.CreatedUtc,
            // Parsed here so the client never has to know it was stored as text.
            citations = string.IsNullOrWhiteSpace(m.CitationsJson)
                ? (JsonElement?)null
                : JsonSerializer.Deserialize<JsonElement>(m.CitationsJson),
        }),
    });
});

chats.MapPatch("/{id:int}", async (
    int id, ChatSessionRename body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var session = await db.ChatSessions.FirstOrDefaultAsync(s => s.Id == id && s.UserId == uid, ct);
    if (session is null) return Results.NotFound();

    var title = body.Title?.Trim();
    if (string.IsNullOrWhiteSpace(title)) return Results.BadRequest(new { error = "A name is required." });

    session.Title = title.Length > 120 ? title[..120] : title;
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { session.Id, session.Title });
});

chats.MapDelete("/{id:int}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var uid = int.Parse(Uid(user));
    var session = await db.ChatSessions.FirstOrDefaultAsync(s => s.Id == id && s.UserId == uid, ct);
    if (session is null) return Results.NotFound();

    // The messages go with it. A conversation is the unit a person deletes, and
    // orphaned turns would be a transcript nobody can reach but the disk keeps.
    await db.ChatMessages.Where(m => m.SessionId == id).ExecuteDeleteAsync(ct);
    db.ChatSessions.Remove(session);
    await db.SaveChangesAsync(ct);
    return Results.NoContent();
});

// ── AI: status, configuration and model download ──────────────────────────────
// The status probe is what lets the assistant explain itself instead of silently
// returning nothing: it reports whether the configured backend can actually answer
// and, when it can't, a sentence the user can act on.
app.MapGet("/api/ai/status", async (AiClient ai, CancellationToken ct) =>
    Results.Ok(await ai.ProbeAsync(ct)))
    .RequireAuthorization()
    .WithTags("AI")
    .WithSummary("Whether the assistant can answer, and why not")
    .RequireAiFeature(aiEnabled);

// The models a user may download when no local model is present. Static metadata,
// so any signed-in user can read it to render the picker; pulling is admin-only.
app.MapGet("/api/ai/models", () => Results.Ok(AiClient.ChatModelChoices))
    .RequireAuthorization()
    .WithTags("AI")
    .WithSummary("Downloadable local models")
    .RequireAiFeature(aiEnabled);

// Admin AI configuration. API keys are write-only over this API — the server says
// whether one is stored, never what it is — the same contract as SSO and SMTP.
var aiAdmin = app.MapGroup("/api/ai/config")
    .RequireAuthorization(p => p.RequireRole("Admin"))
    .WithTags("Admin")
    .RequireAiFeature(aiEnabled);

aiAdmin.MapGet("/", async (AiClient ai, CancellationToken ct) =>
{
    var s = await ai.SettingsAsync(ct);
    return Results.Ok(new
    {
        chatProvider = AiClient.ProviderName(s.ChatProvider),
        embedProvider = AiClient.ProviderName(s.EmbedProvider),
        ollamaBaseUrl = s.OllamaBaseUrl,
        ollamaChatModel = s.OllamaChatModel,
        ollamaEmbedModel = s.OllamaEmbedModel,
        openAiBaseUrl = s.OpenAiBaseUrl,
        openAiChatModel = s.OpenAiChatModel,
        openAiEmbedModel = s.OpenAiEmbedModel,
        anthropicChatModel = s.AnthropicChatModel,
        hasOpenAiKey = !string.IsNullOrWhiteSpace(s.OpenAiKey),
        hasAnthropicKey = !string.IsNullOrWhiteSpace(s.AnthropicKey),
    });
});

aiAdmin.MapPut("/", async (AiConfigWrite body, InstanceConfigStore config, CancellationToken ct) =>
{
    var chat = AiClient.ParseProvider(body.ChatProvider, AiProviderKind.Ollama);
    var embed = AiClient.ParseProvider(body.EmbedProvider, AiProviderKind.Ollama);

    // Anthropic publishes no embeddings endpoint, so it can never serve semantic
    // search. Refuse rather than accept a setting that would quietly stop indexing.
    if (embed == AiProviderKind.Anthropic)
        return Results.BadRequest(new { error = "Anthropic does not offer embeddings. Choose Ollama or OpenAI for semantic search." });

    // Refuse to switch to a provider that cannot work — otherwise the assistant
    // advertises itself as ready and dead-ends on the first question.
    var keyingOpenAi = body.OpenAiKey is { Length: > 0 };
    var keyingAnthropic = body.AnthropicKey is { Length: > 0 };
    if (chat == AiProviderKind.OpenAi && !keyingOpenAi && !config.Has(AiKeys.OpenAiKey))
        return Results.BadRequest(new { error = "An OpenAI API key is required to use OpenAI." });
    if (chat == AiProviderKind.Anthropic && !keyingAnthropic && !config.Has(AiKeys.AnthropicKey))
        return Results.BadRequest(new { error = "An Anthropic API key is required to use Anthropic." });
    if (embed == AiProviderKind.OpenAi && !keyingOpenAi && !config.Has(AiKeys.OpenAiKey))
        return Results.BadRequest(new { error = "An OpenAI API key is required to use OpenAI embeddings." });

    var ollamaUrl = body.OllamaBaseUrl?.Trim() ?? string.Empty;
    if (ollamaUrl.Length > 0 && !Uri.TryCreate(ollamaUrl, UriKind.Absolute, out _))
        return Results.BadRequest(new { error = "Ollama base URL must be an absolute URL." });
    var openAiUrl = body.OpenAiBaseUrl?.Trim() ?? string.Empty;
    if (openAiUrl.Length > 0 && !Uri.TryCreate(openAiUrl, UriKind.Absolute, out _))
        return Results.BadRequest(new { error = "OpenAI base URL must be an absolute URL." });

    var values = new Dictionary<string, string?>
    {
        [AiKeys.ChatProvider] = AiClient.ProviderName(chat),
        [AiKeys.EmbedProvider] = AiClient.ProviderName(embed),
        [AiKeys.OllamaBaseUrl] = ollamaUrl,
        [AiKeys.OllamaChatModel] = body.OllamaChatModel?.Trim() ?? string.Empty,
        [AiKeys.OllamaEmbedModel] = body.OllamaEmbedModel?.Trim() ?? string.Empty,
        [AiKeys.OpenAiBaseUrl] = openAiUrl,
        [AiKeys.OpenAiChatModel] = body.OpenAiChatModel?.Trim() ?? string.Empty,
        [AiKeys.OpenAiEmbedModel] = body.OpenAiEmbedModel?.Trim() ?? string.Empty,
        [AiKeys.AnthropicChatModel] = body.AnthropicChatModel?.Trim() ?? string.Empty,
    };
    // Only overwrite a key when one was supplied, so saving the form with the
    // field left blank keeps the stored value.
    if (body.OpenAiKey is not null) values[AiKeys.OpenAiKey] = body.OpenAiKey.Trim();
    if (body.AnthropicKey is not null) values[AiKeys.AnthropicKey] = body.AnthropicKey.Trim();

    await config.SetAsync(values, ct);
    return Results.NoContent();
})
    .WithSummary("Configure the AI provider (admin)")
    .WithDescription(
        "Selects the chat and embedding backends and stores their API keys. Takes " +
        "effect immediately — AiClient re-reads its settings when the config version bumps.");

// Download a model into Ollama, streaming progress as NDJSON so the UI can show a
// real bar. Admin-only: it writes gigabytes to the host's disk.
app.MapPost("/api/ai/pull", async (
    AiPullRequest body, AiClient ai, InstanceConfigStore config, HttpContext http, CancellationToken ct) =>
{
    var model = body.Model?.Trim();
    if (string.IsNullOrWhiteSpace(model))
        return Results.BadRequest(new { error = "A model name is required." });

    // Only the curated choices may be pulled: the model name reaches a local
    // daemon that will fetch and execute whatever it is told to.
    if (!AiClient.ChatModelChoices.Any(c => c.Model == model) && model != AiClient.DefaultEmbedModel)
        return Results.BadRequest(new { error = "That model isn't one of the offered downloads." });

    http.Response.ContentType = "application/x-ndjson";
    var writer = new StreamWriter(http.Response.Body);

    async Task<bool> PullAsync(string target, string phase)
    {
        await foreach (var frame in ai.PullModelAsync(target, ct))
        {
            await writer.WriteLineAsync(JsonSerializer.Serialize(new
            {
                phase,
                status = frame.Status,
                completed = frame.Completed,
                total = frame.Total,
                error = frame.Error,
            }));
            await writer.FlushAsync(ct); // flush per frame so the bar actually moves
            if (frame.Error is not null) return false;
        }
        return true;
    }

    // One click has to leave the user with a working assistant, not a downloaded
    // file they then have to go and switch on. So: fetch the model, fetch the
    // embedding model that search needs, then make it the active one.
    var ok = await PullAsync(model, "answering");
    if (ok) ok = await PullAsync(AiClient.DefaultEmbedModel, "search");

    if (ok)
    {
        await config.SetAsync(new Dictionary<string, string?>
        {
            [AiKeys.ChatProvider] = AiClient.ProviderName(AiProviderKind.Ollama),
            [AiKeys.EmbedProvider] = AiClient.ProviderName(AiProviderKind.Ollama),
            [AiKeys.OllamaChatModel] = model,
            [AiKeys.OllamaEmbedModel] = AiClient.DefaultEmbedModel,
        }, ct);

        await writer.WriteLineAsync(JsonSerializer.Serialize(new
        {
            phase = "ready", status = "ready", completed = 0L, total = 0L, error = (string?)null,
        }));
        await writer.FlushAsync(ct);
    }
    return Results.Empty;
})
    .RequireAuthorization(p => p.RequireRole("Admin"))
    .WithTags("Admin")
    .WithSummary("Download a local model (admin)")
    .RequireAiFeature(aiEnabled);

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
}).RequireAuthorization().RequireAiFeature(aiEnabled);

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
    SearchRebuilder rebuilder,
    IHubContext<NotesHub> hub,
    CancellationToken ct) =>
{
    await hub.Clients.All.SendAsync("SystemRebuilding", ct);
    return Results.Ok(new { rebuilt = await rebuilder.RebuildUserAsync(Uid(user), ct) });
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

    // Generous, per kind: a phone photo or a big GIF always fits; video and
    // documents get a ceiling so one upload can't fill the disk.
    var (kindLabel, limit) = MediaLimits.For(file.FileName);
    if (file.Length > limit)
        return Results.Json(new
        {
            error = $"That {kindLabel} is {MediaLimits.Human(file.Length)} — the limit for {kindLabel}s is {MediaLimits.Human(limit)}.",
            code = "too_large",
            limit,
        }, statusCode: StatusCodes.Status413PayloadTooLarge);

    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, Uid(user));
    Directory.CreateDirectory(mediaDir);

    // A readable name — the original's, slugged — plus a short suffix so two
    // pasted "image.png"s never clobber each other: `airway-bill-3f9a2c.jpg`,
    // not a 32-character id.
    var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
    if (ext.Length > 10 || ext.Any(c => !char.IsLetterOrDigit(c) && c != '.')) ext = "";
    var slug = NoteFileNamer.Slug(Path.GetFileNameWithoutExtension(file.FileName));
    if (slug.Length == 0) slug = "file";
    if (slug.Length > 48) slug = slug[..48].TrimEnd('-');
    var filename = $"{slug}-{Guid.NewGuid().ToString("N")[..6]}{ext}";

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
// The per-kind limits above do the real policing; these just let the largest
// allowed upload (a video) through Kestrel's and the form reader's defaults.
.WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MediaLimits.Largest + 1_048_576))
.WithFormOptions(multipartBodyLengthLimit: MediaLimits.Largest + 1_048_576)
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

    var status = import.Enqueue(Uid(user), provider, tmp);
    if (status is null)
    {
        File.Delete(tmp);
        return Results.Conflict(new { error = "An import is already running. Wait for it to finish." });
    }
    return Results.Accepted(value: status);
})
.RequireAuthorization()
.DisableAntiforgery();

// The caller's running import (or the last one's summary) — lets the Settings page
// resume the progress bar after navigating away. 204 when there's never been one.
app.MapGet("/api/import/status", (ClaimsPrincipal user, ImportService import) =>
    import.StatusFor(Uid(user)) is { } status ? Results.Ok(status) : Results.NoContent())
.RequireAuthorization();

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

// ── Delete my account ─────────────────────────────────────────────────────────
// The one irreversible thing a person can do here, so it asks for everything:
//   • the account password,
//   • an open vault (PIN or biometric, X-Unlock-Token),
//   • a 6-digit code emailed to the account (so a stolen session plus a guessed
//     password is still not enough),
//   • their username typed out, and
//   • a password that has not changed in the last 24 hours (so whoever just
//     took the account over can't immediately erase the evidence).
// Even then it only SCHEDULES deletion a week out (AccountDeletion). Until
// then the account can sign in to cancel, and is emailed daily.
var accountDelete = app.MapGroup("/api/account/delete").RequireAuthorization().WithTags("Account")
    .AddEndpointFilter(async (ctx, next) =>
        IsApiKey(ctx.HttpContext.User)
            ? Results.Json(new { error = "Account deletion needs you signed in, not an API key." },
                statusCode: StatusCodes.Status403Forbidden)
            : await next(ctx));

accountDelete.MapGet("/", async (ClaimsPrincipal principal, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var me = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (me is null) return Results.NotFound();
    await Task.CompletedTask;
    var blockers = new List<string>();
    if (me.PasswordChangedUtc is { } changed && DateTime.UtcNow - DateTime.SpecifyKind(changed, DateTimeKind.Utc) < AccountDeletion.MinPasswordAge)
        blockers.Add($"Your password was changed less than 24 hours ago. You can delete the account after {DateTime.SpecifyKind(changed, DateTimeKind.Utc).Add(AccountDeletion.MinPasswordAge):u}.");
    if (string.IsNullOrEmpty(me.VaultPinHash)) blockers.Add("Set a vault PIN first (Settings → Security) — it is one of the checks.");
    // A code confirms it: the authenticator's, or one emailed to the account.
    if (!TotpService.IsEnabled(me))
    {
        if (string.IsNullOrWhiteSpace(me.Email)) blockers.Add("Set up an authenticator app (Settings → Security) or add an email address — a code confirms it.");
        else if (!email.IsConfigured) blockers.Add("Set up an authenticator app (Settings → Security) — this Papyra can't email you a code.");
    }
    if (me.Role == "Admin" && await db.Users.CountAsync(u => u.Role == "Admin" && u.Id != me.Id && u.DeletionScheduledUtc == null, ct) == 0)
        blockers.Add("You're the only administrator. Make someone else an admin first.");
    return Results.Ok(new
    {
        scheduledUtc = me.DeletionScheduledUtc is { } s ? DateTime.SpecifyKind(s, DateTimeKind.Utc) : (DateTime?)null,
        blockers,
        graceDays = (int)AccountDeletion.GracePeriod.TotalDays,
        totp = TotpService.IsEnabled(me),
        canEmail = email.IsConfigured && !string.IsNullOrWhiteSpace(me.Email),
    });
});

accountDelete.MapPost("/code", async (
    AccountDeletePassword body, ClaimsPrincipal principal, HttpContext http, AppDbContext db, EmailSender email,
    LoginThrottle throttle, CancellationToken ct) =>
{
    var me = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (me is null) return Results.NotFound();
    var key = $"delete:{me.Username}";
    if (throttle.IsLockedOut(key)) return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: 429);
    if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, me.PasswordHash))
    {
        throttle.RecordFailure(key);
        return Results.Json(new { error = "That password isn't right.", field = "password" }, statusCode: 401);
    }
    if (string.IsNullOrWhiteSpace(me.Email) || !email.IsConfigured)
        return Results.BadRequest(new { error = "A confirmation code can't be emailed to this account." });

    var code = System.Security.Cryptography.RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
    db.AuthTokens.RemoveRange(db.AuthTokens.Where(t => t.UserId == me.Id && t.Kind == "account-delete"));
    db.AuthTokens.Add(new AuthToken
    {
        TokenHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{me.Id}:{code}"))),
        Kind = "account-delete",
        UserId = me.Id,
        Email = me.Email,
        Username = me.Username,
        ExpiresUtc = DateTime.UtcNow.AddMinutes(10),
    });
    await db.SaveChangesAsync(ct);

    var sent = await email.SendAsync(me.Email, $"{code} is your code to delete your Papyra account",
        $"Someone — hopefully you — started deleting the Papyra account @{me.Username}.\n\n"
        + $"Your confirmation code is {code}. It works once, for 10 minutes.\n\n"
        + "If this wasn't you, don't share the code: change your password and vault PIN now.",
        [
            new EmailDetail("Code", code),
            new EmailDetail("Requested from", http.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
            new EmailDetail("Browser / device", http.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : "unknown"),
        ], ct);
    return sent.Sent
        ? Results.Ok(new { sentTo = MaskEmail(me.Email) })
        : Results.BadRequest(new { error = "The code couldn't be emailed. Try again shortly." });
}).RequireRateLimiting(AuthRateLimit);

accountDelete.MapPost("/", async (
    AccountDeleteRequest body, ClaimsPrincipal principal, HttpContext http, AppDbContext db, EmailSender email,
    LoginThrottle throttle, UnlockTokenStore unlockTokens, TotpService totp, CancellationToken ct) =>
{
    var uid = Uid(principal);
    var me = await db.Users.FindAsync([int.Parse(uid)], ct);
    if (me is null) return Results.NotFound();
    if (me.DeletionScheduledUtc is not null) return Results.Conflict(new { error = "Deletion is already scheduled." });
    var key = $"delete:{me.Username}";
    if (throttle.IsLockedOut(key)) return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: 429);

    if (!string.Equals(body.ConfirmUsername?.Trim(), me.Username, StringComparison.Ordinal))
        return Results.BadRequest(new { error = "Type your username exactly to confirm.", field = "confirm" });
    if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, me.PasswordHash))
    {
        throttle.RecordFailure(key);
        return Results.Json(new { error = "That password isn't right.", field = "password" }, statusCode: 401);
    }
    if (string.IsNullOrEmpty(me.VaultPinHash) || !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock your vault with your PIN first.", code = "locked" }, statusCode: 401);
    if (me.PasswordChangedUtc is { } changed && DateTime.UtcNow - DateTime.SpecifyKind(changed, DateTimeKind.Utc) < AccountDeletion.MinPasswordAge)
        return Results.BadRequest(new { error = "Your password changed in the last 24 hours. Try again once a day has passed." });
    if (me.Role == "Admin" && await db.Users.CountAsync(u => u.Role == "Admin" && u.Id != me.Id && u.DeletionScheduledUtc == null, ct) == 0)
        return Results.BadRequest(new { error = "You're the only administrator. Make someone else an admin first." });

    // Either code will do: the authenticator's, or the one emailed by /code.
    if (!totp.Verify(me, body.Code))
    {
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{me.Id}:{body.Code?.Trim()}")));
        var token = await db.AuthTokens.FirstOrDefaultAsync(t => t.UserId == me.Id && t.Kind == "account-delete" && t.TokenHash == hash, ct);
        if (token is null || token.UsedUtc is not null || token.ExpiresUtc < DateTime.UtcNow)
        {
            throttle.RecordFailure(key);
            return Results.BadRequest(new { error = "That code is wrong or has expired.", field = "code" });
        }
        token.UsedUtc = DateTime.UtcNow;
    }

    var due = DateTime.UtcNow.Add(AccountDeletion.GracePeriod);
    me.DeletionScheduledUtc = due;
    me.DeletionReminderUtc = DateTime.UtcNow;
    await db.SaveChangesAsync(ct);
    throttle.Reset(key);
    unlockTokens.RevokeUser(uid);

    await email.SendAsync(me.Email, "Your Papyra account is scheduled for deletion",
        $"The account @{me.Username} will be permanently deleted in {(int)AccountDeletion.GracePeriod.TotalDays} days, "
        + "along with every note, attachment and version in it.\n\n"
        + "Until then you can sign in and choose “Keep my account” to cancel. You'll get a reminder each day.",
        [
            new EmailDetail("Deletion date", $"{due:dddd d MMMM yyyy, HH:mm} UTC"),
            new EmailDetail("Requested from", http.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
            new EmailDetail("Browser / device", http.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : "unknown"),
        ], ct);
    return Results.Ok(new { scheduledUtc = due });
}).RequireRateLimiting(AuthRateLimit);

accountDelete.MapPost("/cancel", async (
    AccountDeletePassword body, ClaimsPrincipal principal, AppDbContext db, EmailSender email, CancellationToken ct) =>
{
    var me = await db.Users.FindAsync([int.Parse(Uid(principal))], ct);
    if (me is null) return Results.NotFound();
    if (me.DeletionScheduledUtc is null) return Results.NoContent();
    if (string.IsNullOrEmpty(body.Password) || !BCrypt.Net.BCrypt.Verify(body.Password, me.PasswordHash))
        return Results.Json(new { error = "That password isn't right.", field = "password" }, statusCode: 401);
    me.DeletionScheduledUtc = null;
    me.DeletionReminderUtc = null;
    await db.SaveChangesAsync(ct);
    await email.SendAsync(me.Email, "Your Papyra account is staying",
        $"Deletion of the account @{me.Username} was cancelled. Everything is exactly as you left it.", ct);
    return Results.NoContent();
}).RequireRateLimiting(AuthRateLimit);

// The installation's public host (the configured public URL, else the host this
// request arrived on) — the "domain" half of a user@domain handle.
static string InstanceDomain(EmailSender email, HttpContext http)
{
    var origin = email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}");
    return Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri.Host : http.Request.Host.Host;
}

static string MaskEmail(string address)
{
    var at = address.IndexOf('@');
    if (at <= 1) return address;
    return address[0] + new string('•', Math.Min(6, at - 1)) + address[at..];
}

// ── Link previews ─────────────────────────────────────────────────────────────
// Title / summary / picture for a URL in a note, for the Keep-style link cards
// under a note and the hover card on a link. Server-fetched and SSRF-guarded
// (see LinkPreviewService); signed-in only, and rate-limited so the endpoint
// can't be turned into a free crawler.
app.MapGet("/api/link-preview", async (string? url, LinkPreviewService previews, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(url) || url.Length > 2048) return Results.BadRequest();
    var preview = await previews.GetAsync(url.Trim(), ct);
    return preview is null ? Results.NoContent() : Results.Ok(preview);
})
.RequireAuthorization()
.RequireRateLimiting(PreviewRateLimit);

// ── Export all notes ──────────────────────────────────────────────────────────
// Everything a person owns, as plain files — so it is guarded like the keys to
// the account. Two steps:
//   1. POST /api/export/authorize — the account password AND an open vault (the
//      vault PIN or a biometric device, via X-Unlock-Token) earn a one-time
//      ticket, good for two minutes. An API key can't: this is a person's act.
//   2. GET /api/export?ticket=… — the download itself (a plain link, so the
//      browser saves the file natively), then an email to the account saying
//      exactly what happened: who, when, from where, how much.
// Locked (vault) notes travel too, in a separate `vault/` folder.
app.MapPost("/api/export/authorize", async (
    ExportAuthorizeRequest body, ClaimsPrincipal user, HttpContext http, AppDbContext db,
    ExportTicketStore tickets, LoginThrottle throttle, CancellationToken ct) =>
{
    if (IsApiKey(user)) return Results.Json(new { error = "Exports need you signed in, not an API key." }, statusCode: StatusCodes.Status403Forbidden);
    var uid = Uid(user);
    var me = await db.Users.FindAsync([int.Parse(uid)], ct);
    if (me is null) return Results.NotFound();

    var throttleKey = $"export:{me.Username}";
    if (throttle.IsLockedOut(throttleKey))
        return Results.Json(new { error = "Too many attempts. Try again later." }, statusCode: StatusCodes.Status429TooManyRequests);
    if (string.IsNullOrEmpty(body.Password) || string.IsNullOrEmpty(me.PasswordHash)
        || !BCrypt.Net.BCrypt.Verify(body.Password, me.PasswordHash))
    {
        throttle.RecordFailure(throttleKey);
        return Results.Json(new { error = "That password isn't right.", code = "password" }, statusCode: StatusCodes.Status401Unauthorized);
    }
    // The vault must be open right now. Every account has a PIN before it can
    // lock anything; without one there is simply no vault to prove.
    if (!string.IsNullOrEmpty(me.VaultPinHash) && !UnlockedNow(http, uid))
        return Results.Json(new { error = "Unlock your vault to export.", code = "locked" }, statusCode: StatusCodes.Status401Unauthorized);

    throttle.Reset(throttleKey);
    return Results.Ok(new { ticket = tickets.Issue(uid) });
})
.RequireAuthorization()
.RequireRateLimiting(AuthRateLimit);

app.MapGet("/api/export", async (
    string? ticket,
    ClaimsPrincipal user,
    HttpContext http,
    VaultState state,
    AppDbContext db,
    ExportTicketStore tickets,
    BlockAnchorCleanup anchors,
    EmailSender email,
    IConfiguration config,
    IHostEnvironment env,
    ILoggerFactory lf,
    CancellationToken ct) =>
{
    var uid = Uid(user);
    if (!tickets.Redeem(ticket, uid))
        return Results.Json(new { error = "Confirm with your password and vault first.", code = "ticket" },
            statusCode: StatusCodes.Status403Forbidden);

    // Zip entries carry a bare local clock time (no zone), which an unzipper
    // reads as its own local time. Write each file's real last-modified moment
    // in the person's zone (Settings → Profile, else the server's), so a note
    // edited at 9:14 unpacks as 9:14 on their machine — and every file keeps
    // its own date rather than the moment of export.
    var me = await db.Users.FindAsync([int.Parse(uid)], ct);
    var zone = TimeZoneInfo.Local;
    if (me?.TimeZone is { Length: > 0 } tzId && TimeZoneInfo.TryFindSystemTimeZoneById(tzId, out var chosen)) zone = chosen;
    DateTimeOffset InZone(DateTime utc)
    {
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), zone);
        // The zip format can't store dates before 1980; clamp rather than throw.
        if (local.Year < 1980) local = new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), zone.GetUtcOffset(local));
    }

    // Unused block markers (`^k2x9…`) are left out of exported notes: they are
    // editor bookkeeping, not writing. Anchors something links to are kept.
    var keepAnchors = await anchors.InUseAsync(ct);

    // Built by hand rather than CreateEntryFromFile: in Create mode an entry is
    // sealed once written, so its time has to be set before the bytes go in.
    void AddFile(ZipArchive zip, string file, string entryName)
    {
        var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        entry.LastWriteTime = InZone(File.GetLastWriteTimeUtc(file));
        using var target = entry.Open();
        if (file.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            var text = BlockResolver.StripAnchors(File.ReadAllText(file), keepAnchors);
            var bytes = System.Text.Encoding.UTF8.GetBytes(text);
            target.Write(bytes, 0, bytes.Length);
        }
        else
        {
            using var source = File.OpenRead(file);
            source.CopyTo(target);
        }
    }

    var secureFiles = state.Snapshot(uid).Where(n => n.Secure)
        .Select(n => state.PathFor(uid, n.Id))
        .Where(p => p is not null)
        .Select(p => Path.GetFullPath(p!))
        .ToHashSet(StringComparer.OrdinalIgnoreCase);
    var notesDir = PapyraPaths.UserNotesDir(config, env.ContentRootPath, uid);
    var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, uid);
    Directory.CreateDirectory(notesDir);

    int notesCount = 0, vaultCount = 0, mediaCount = 0;
    var tmp = Path.Combine(Path.GetTempPath(), $"papyra-export-{Guid.NewGuid():N}.zip");
    using (var archive = ZipFile.Open(tmp, ZipArchiveMode.Create))
    {
        foreach (var file in Directory.EnumerateFiles(notesDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(notesDir, file).Replace('\\', '/');
            // Locked notes go in their own folder, so it is obvious which files
            // hold what the vault was protecting.
            if (secureFiles.Contains(Path.GetFullPath(file)))
            {
                AddFile(archive, file, "vault/" + rel);
                vaultCount++;
            }
            else
            {
                AddFile(archive, file, rel);
                if (rel.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) notesCount++;
            }
        }

        // Attachments too. Exporting notes without the images they embed leaves
        // every ![[file]] dangling the moment the archive is opened somewhere
        // else — the paths stay relative to `media/`, exactly as on disk.
        if (Directory.Exists(mediaDir))
        {
            foreach (var file in Directory.EnumerateFiles(mediaDir, "*", SearchOption.AllDirectories))
            {
                AddFile(archive, file, "media/" + Path.GetRelativePath(mediaDir, file).Replace('\\', '/'));
                mediaCount++;
            }
        }
    }

    var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, zone);
    var size = new FileInfo(tmp).Length;

    // Tell the account owner. Security mail: always sent (when there's an
    // address and mail is set up), never blocks the download.
    if (me is not null && !string.IsNullOrWhiteSpace(me.Email))
    {
        var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var agent = http.Request.Headers.UserAgent.ToString();
        var details = new List<EmailDetail>
        {
            new("Account", $"@{me.Username}{(string.IsNullOrWhiteSpace(me.Name) || me.Name == me.Username ? "" : $" ({me.Name})")}"),
            new("When", $"{nowLocal:dddd d MMMM yyyy, HH:mm:ss} ({zone.Id})"),
            new("From IP address", ip),
            new("Browser / device", string.IsNullOrWhiteSpace(agent) ? "unknown" : agent),
            new("Confirmed with", "Password + vault unlock"),
            new("Notes", notesCount.ToString()),
            new("Vault (locked) notes", vaultCount.ToString()),
            new("Attachments", mediaCount.ToString()),
            new("Archive size", size >= 1_048_576 ? $"{size / 1_048_576.0:0.0} MB" : $"{Math.Max(1, size / 1024)} KB"),
            new("Server", email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}")),
        };
        var owner = me;
        _ = Task.Run(async () =>
        {
            try
            {
                await email.NotifyAsync(owner, NotificationCatalog.ExportReady, "Your notes were exported",
                    "A full export of your Papyra notes — including your vault — was just downloaded.\n\n"
                    + "If that was you, there's nothing to do. If it wasn't, change your password and vault PIN "
                    + "straight away, and tell your Papyra administrator.",
                    details, CancellationToken.None);
            }
            catch (Exception ex)
            {
                lf.CreateLogger("Export").LogWarning(ex, "Export notice email failed");
            }
        });
    }

    // DeleteOnClose reclaims the temp zip once the response stream finishes.
    var stream = new FileStream(
        tmp, FileMode.Open, FileAccess.Read, FileShare.None, 4096, FileOptions.DeleteOnClose);
    // Dated, so a folder of exports sorts itself and one never overwrites another.
    return Results.File(stream, "application/zip", $"papyra-export-{nowLocal:yyyy-MM-dd-HHmm}.zip");
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
    BackupLayout layout,
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

    // Notes, to-dos, locked notes, media by kind and the account's settings, laid
    // out as BackupLayout describes — the same tree a git backup holds.
    var stage = Path.Combine(Path.GetTempPath(), $"papyra-backup-{Guid.NewGuid():N}");
    try
    {
        await layout.BuildAsync(user, db, stage, ct);
        http.Response.ContentType = "application/octet-stream";
        http.Response.Headers.ContentDisposition = "attachment; filename=\"papyra-backup.papyra-vault\"";
        await backup.BackupAsync([(string.Empty, stage)], body.Password, http.Response.Body, ct);
        return Results.Empty;
    }
    finally
    {
        if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true);
    }
})
    .WithSummary("Generate encrypted backup")
    .WithDescription("Verifies the account password, then streams an AES-GCM encrypted .papyra-vault of the caller's notes + media.");

backups.MapPost("/restore", async (
    HttpRequest request,
    ClaimsPrincipal principal,
    AppDbContext db,
    EncryptedBackupService backup,
    BackupLayout layout,
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

        // Notes, media and settings back into the live shape (either backup
        // version), then a per-tenant cache rebuild from the restored files.
        await layout.ApplyAsync(staging, user, db, restoreProfile: true, ct);
        var restored = await RescanUserAsync(uidStr, config, env, state, storage, search, observer, hub, ct);
        return Results.Ok(new { restored });
    }
    finally
    {
        if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
    }
})
    .DisableAntiforgery()
    .WithSummary("Restore from encrypted backup")
    .WithDescription("Decrypts an uploaded .papyra-vault (multipart: password + file) and replaces the caller's notes + media, then rebuilds the cache.");

// Restore the signed-in account from a git backup — plain or encrypted, current
// layout or the older whole-directory mirror — and (by default) keep backing up
// to the same repository afterwards, continuing its history.
backups.MapPost("/restore-git", async (
    GitRestoreRequest body,
    ClaimsPrincipal principal,
    AppDbContext db,
    BackupLayout layout,
    GitSyncService git,
    VaultState state,
    SearchIndexService search,
    MarkdownStorageService storage,
    VaultObserver observer,
    IHubContext<NotesHub> hub,
    IConfiguration config,
    IHostEnvironment env,
    CancellationToken ct) =>
{
    var remote = body.RemoteUrl?.Trim() ?? string.Empty;
    if (!Uri.TryCreate(remote, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
        return Results.BadRequest(new { error = "Paste the repository's https address, e.g. https://github.com/you/papyra-notes.git" });
    var branch = string.IsNullOrWhiteSpace(body.Branch) ? "main" : body.Branch.Trim();

    var uidStr = Uid(principal);
    var user = await db.Users.FindAsync([int.Parse(uidStr)], ct);
    if (user is null) return Results.NotFound();

    // A token left blank reuses the one saved for backups, like the connection test.
    var token = body.Token?.Trim();
    if (string.IsNullOrEmpty(token))
    {
        var tokenKey = GitKeys.Token(uidStr);
        token = (await db.Settings.FirstOrDefaultAsync(s => s.Key == tokenKey, ct))?.Value;
    }

    var staging = Path.Combine(PapyraPaths.UserDotPapyra(config, env.ContentRootPath, uidStr), $"restore-git-{Guid.NewGuid():N}");
    try
    {
        var staged = await StageGitBackupAsync(remote, branch, token, body.Password, Path.Combine(staging, "plain"), git, ct);
        if (staged.Error is not null) return Results.BadRequest(new { error = staged.Error, code = staged.Code });
        var summary = BackupLayout.Summarize(Path.Combine(staging, "plain"));

        await layout.ApplyAsync(Path.Combine(staging, "plain"), user, db, restoreProfile: true, ct);
        var restored = await RescanUserAsync(uidStr, config, env, state, storage, search, observer, hub, ct);

        if (body.KeepSyncing)
        {
            // Re-seal an encrypted backup under this account's password when it
            // was given and is right; otherwise the password it was made with
            // keeps unlocking it.
            var rewrap = !string.IsNullOrEmpty(body.AccountPassword) && BCrypt.Net.BCrypt.Verify(body.AccountPassword, user.PasswordHash)
                ? body.AccountPassword : null;
            await SaveGitBackupConfigAsync(db, git, uidStr, remote, branch, token, staged.Source!, rewrap, config, env, ct);
        }
        return Results.Ok(new { restored, summary });
    }
    finally
    {
        if (Directory.Exists(staging)) DeleteDirectoryForce(staging);
    }
})
    .RequireRateLimiting(AuthRateLimit)
    .WithSummary("Restore from a git backup")
    .WithDescription("Downloads the caller's git backup (decrypting it with the given password when it is encrypted), replaces their notes, media and settings with it, and optionally keeps backing up there.");

// Signed-in only, and events go to the owning user (Clients.User keys on the
// NameIdentifier claim, i.e. the user id). Anonymous and cross-tenant listeners
// used to receive every note title and tag in real time.
app.MapHub<NotesHub>("/hubs/notes").RequireAuthorization();

// An unmatched /api route must NOT fall through to the SPA: a client asking for
// `/api/shared/` (or any typo'd endpoint) was handed 200 text/html, so `res.ok`
// was true and the JSON parse blew up somewhere far from the cause. Answer in the
// shape the caller asked for.
app.MapFallback("/api/{**rest}", (HttpContext http) =>
    Results.Json(new { error = "No such endpoint.", path = http.Request.Path.Value }, statusCode: StatusCodes.Status404NotFound))
    .ExcludeFromDescription();

app.MapCollab();
app.MapFallbackToFile("index.html");

app.Run();

// True when anything in the exception chain is a network/transport failure.
// Scoped to the SSO paths by its only caller, so a genuine bug elsewhere is
// never swallowed as "the IdP was unreachable".
// A share just granted or upgraded closes any request it answers — the grantee
// asked for edit, the owner shared as editor from the dialog instead: that is a yes.
static async Task SettleAccessRequests(AppDbContext db, int ownerId, string noteId, int granteeId, string access, CancellationToken ct)
{
    var open = await db.AccessRequests.Where(r => r.OwnerId == ownerId && r.NoteId == noteId
        && r.RequesterUserId == granteeId && r.Status == "pending").ToListAsync(ct);
    foreach (var r in open.Where(r => access == "edit" || r.Access == "view"))
    {
        r.Status = "approved";
        r.ResolvedUtc = DateTime.UtcNow;
    }
}

// Tell someone a note was shared with them, their access went up, or their
// request was approved: a tray entry, a live push so their screens update in
// place, and an email when they asked for share mail. The body is never quoted —
// email is outside the share.
static async Task AnnounceShare(
    AppDbContext db, IHubContext<NotesHub> hub, EmailSender email, HttpContext http, User recipient,
    ClaimsPrincipal sharer, int ownerId, string noteId, string? title, string access, string kind,
    CancellationToken ct, int? requestId = null)
{
    db.Notifications.Add(new Notification
    {
        UserId = recipient.Id, Kind = kind, ActorUserId = ownerId, OwnerId = ownerId, NoteId = noteId,
        Access = access, AccessRequestId = requestId, CreatedUtc = DateTime.UtcNow,
    });
    await db.SaveChangesAsync(ct);
    await hub.Clients.User(recipient.Id.ToString()).SendAsync("SharesChanged", ct);
    await hub.Clients.User(recipient.Id.ToString()).SendAsync("NotificationsChanged", ct);

    var eventId = kind == "access_approved" ? NotificationCatalog.AccessAnswered : NotificationCatalog.Shared;
    if (!NotificationPrefs.Wants(recipient, eventId) || !email.IsConfigured) return;
    var who = sharer.FindFirstValue(ClaimTypes.Name) ?? "Someone";
    var name = string.IsNullOrWhiteSpace(title) ? "Untitled" : title;
    var url = email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}");
    var role = access == "edit" ? "can edit" : "can view";
    var (subject, lead) = kind switch
    {
        "access_upgraded" => ($"You can now edit “{name}”", $"@{who} gave you edit access to “{name}”."),
        "access_approved" => ($"@{who} approved your request", $"@{who} approved your request — you {role} “{name}”."),
        _ => ($"@{who} shared “{name}” with you", $"@{who} shared “{name}” with you ({role})."),
    };
    await email.NotifyAsync(recipient, eventId, subject, $"{lead}\n\nOpen it in Papyra: {url}/shared-with-me", ct: ct);
}

// A card-sized plain-text taste of a note body.
static string ShareExcerpt(string? body)
{
    var flat = PlainText.Flatten(body).Replace('\n', ' ');
    return flat.Length <= 160 ? flat : flat[..157].TrimEnd() + "…";
}

static bool IsNetworkFailure(Exception? ex)
{
    for (var e = ex; e is not null; e = e.InnerException)
    {
        if (e is HttpRequestException or IOException or System.Net.Sockets.SocketException) return true;
    }
    return false;
}

// SSO is usable only when an admin has switched it on AND supplied the two
// fields the protocol cannot work without. Checked per request against the live
// store, never cached from startup, so enabling SSO takes effect immediately.
static bool SsoConfigured(InstanceConfigStore config) =>
    config.GetBool(OidcKeys.Enabled)
    && config.Has(OidcKeys.Authority)
    && config.Has(OidcKeys.ClientId);

// The authenticated tenant id, lifted from the NameIdentifier claim minted at
// sign-in. Every per-user storage path keys off this.
// The vault is open on this request: a live unlock token for this user, from the
// browser session (never an API key).
static bool UnlockedNow(HttpContext http, string uid) =>
    !IsApiKey(http.User)
    && http.RequestServices.GetRequiredService<UnlockTokenStore>()
        .IsValid(http.Request.Headers["X-Unlock-Token"].ToString(), uid);

// Whether the live note with this id is currently secure.
static bool IsSecureNow(VaultState state, string uid, string id) =>
    state.PathFor(uid, id) is { } path && state.TryGet(uid, path, out var live) && live?.Secure == true;

// A principal signed in with an API key rather than the browser session.
static bool IsApiKey(ClaimsPrincipal user) => user.Identity?.AuthenticationType == "ApiKey";

// Changing what can open the vault needs the vault PIN to exist and to be open
// right now on this session. Null when allowed.
static IResult? VaultGuard(User user, HttpRequest request, UnlockTokenStore unlockTokens)
{
    if (string.IsNullOrEmpty(user.VaultPinHash))
        return Results.Json(new { error = "Set a vault PIN first.", code = "pin_not_set" },
            statusCode: StatusCodes.Status409Conflict);
    if (!unlockTokens.IsValid(request.Headers["X-Unlock-Token"].ToString(), user.Id.ToString()))
        return Results.Json(new { error = "Unlock the vault first.", code = "locked" },
            statusCode: StatusCodes.Status401Unauthorized);
    return null;
}

// The response for a PIN that did not open the vault.
static IResult PinFailure(PinVerdict verdict) => verdict.Result switch
{
    PinCheck.Locked => Results.Json(new
    {
        error = "Too many wrong PINs. Wait before trying again.", code = "pin_locked",
        lockedUntilUtc = verdict.LockedUntilUtc, attemptsLeft = verdict.AttemptsLeft,
    }, statusCode: StatusCodes.Status429TooManyRequests),
    PinCheck.Disabled => Results.Json(new
    {
        error = "Your PIN is disabled after too many wrong tries. Reset it with your account password.",
        code = "pin_disabled",
    }, statusCode: StatusCodes.Status423Locked),
    PinCheck.NotSet => Results.Json(new { error = "Set a vault PIN first.", code = "pin_not_set" },
        statusCode: StatusCodes.Status409Conflict),
    _ => Results.Json(new
    {
        error = "Wrong PIN.", code = "pin_wrong",
        attemptsLeft = verdict.AttemptsLeft, lockedUntilUtc = verdict.LockedUntilUtc,
    }, statusCode: StatusCodes.Status401Unauthorized),
};

static string Uid(ClaimsPrincipal user) =>
    user.FindFirstValue(ClaimTypes.NameIdentifier)
    ?? throw new SecurityException("Authenticated principal carries no user id.");

// The character set a username is allowed to draw on, and therefore the only
// characters a typeahead prefix can meaningfully contain. Mirrors the mention
// token class in MentionDeliveryService.
static bool IsUsernameChar(char c) =>
    char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-';

// Mint a reset/invite token: a URL-safe random string for the email, and the
// SHA-256 that is all the database ever holds. A stolen database backup
// therefore yields no usable links.
// A first password an admin can read out over the phone without spelling half of
// it. Ambiguous characters (0/O, 1/l/I) are left out, and the alphabet is sampled
// without modulo bias, so the entropy is the ~62 bits the length implies.
static string GeneratePassword()
{
    const string alphabet = "abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
    var chars = new char[16];
    for (var i = 0; i < chars.Length; i++)
        chars[i] = alphabet[System.Security.Cryptography.RandomNumberGenerator.GetInt32(alphabet.Length)];
    // Grouped for reading aloud: xxxx-xxxx-xxxx-xxxx.
    return string.Join('-', Enumerable.Range(0, 4).Select(g => new string(chars, g * 4, 4)));
}

// A conversation's name, taken from its first question. Truncated on a word
// boundary where possible: "How do I..." beats "How do I export everyth".
static string ChatTitle(string question)
{
    var flat = question.Replace('\n', ' ').Trim();
    if (flat.Length <= 60) return flat;
    var cut = flat[..60];
    var space = cut.LastIndexOf(' ');
    return (space > 30 ? cut[..space] : cut).TrimEnd() + "…";
}

static (string Token, string Hash) NewAuthToken()
{
    var bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
    var token = Convert.ToBase64String(bytes)
        .Replace('+', '-').Replace('/', '_').TrimEnd('=');
    return (token, Sha256Hex(token));
}

// Look up a token that is still redeemable: right hash, unused, unexpired.
static async Task<AuthToken?> FindLiveToken(AppDbContext db, string token, CancellationToken ct)
{
    if (string.IsNullOrWhiteSpace(token)) return null;
    var hash = Sha256Hex(token);
    var now = DateTime.UtcNow;
    return await db.AuthTokens.FirstOrDefaultAsync(
        t => t.TokenHash == hash && t.UsedUtc == null && t.ExpiresUtc > now, ct);
}

// Hex SHA-256 — the at-rest form of an API token (lookup key on each request).
static string Sha256Hex(string input) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(input)));

// Resolve a note's .md path inside an arbitrary owner's vault (used by shares to
// reach across tenants — authorised by the Share row, jailed by PathGuard).
static string OwnerNotePath(VaultState state, VaultObserverOptions vault, ILoggerFactory lf, string ownerUid, string noteId) =>
    state.PathFor(ownerUid, noteId)
    ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(ownerUid), $"{noteId}.md", lf.CreateLogger("PathGuard"));

// Identify an image by its magic bytes rather than by what the upload claims to
// be. Only these three: each is a raster format that cannot carry script, which
// is the whole reason for the check.
static (string Extension, string ContentType)? SniffImage(ReadOnlySpan<byte> bytes)
{
    if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47
        && bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A)
        return (".png", "image/png");
    if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
        return (".jpg", "image/jpeg");
    if (bytes.Length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
        && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P')
        return (".webp", "image/webp");
    return null;
}

// Serve a stored avatar. The content type comes from the extension the upload
// path chose, never from anything a caller supplied, and the response says
// nosniff so a browser cannot decide it is something more exciting.
static IResult AvatarFile(string uid, IConfiguration config, IHostEnvironment env, HttpResponse response)
{
    var dir = PapyraPaths.UserDotPapyra(config, env.ContentRootPath, uid);
    var file = Directory.Exists(dir) ? Directory.EnumerateFiles(dir, "avatar.*").FirstOrDefault() : null;
    if (file is null) return Results.NotFound();
    var contentType = Path.GetExtension(file) switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        // Written before the upload path validated anything. Refuse rather than
        // guess: whatever it is, it is not something this endpoint promised.
        _ => null,
    };
    if (contentType is null) return Results.NotFound();
    // The URL stays the same across uploads, so the browser must revalidate
    // every time (a cheap 304 when nothing changed). With no caching headers it
    // guessed a freshness from Last-Modified and kept showing an old picture —
    // "View photo" opened the previous face.
    response.Headers.CacheControl = "private, no-cache";
    var modified = File.GetLastWriteTimeUtc(file);
    return Results.File(file, contentType,
        lastModified: modified,
        entityTag: new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{modified.Ticks:x}\""));
}

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
    IHubContext<NotesHub> hub, VaultObserverOptions vault, ILoggerFactory lf,
    ICollabEngine collab, NoteWriteLocks writeLocks, CancellationToken ct)
{
    var path = OwnerNotePath(state, vault, lf, ownerUid, noteId);
    using var writeLock = await writeLocks.AcquireAsync(ownerUid, noteId, ct);
    var note = await storage.ReadAsync(path, ct);
    if (note is null) return Results.NotFound();
    // A body write through the classic path while the note is open live would
    // overwrite everyone in the room.
    if (await CollabEndpoints.BodyWriteGuardAsync(collab, ownerUid, noteId, note.Body, newBody, ct) is { } busy)
        return busy;
    // A locked note is not writable from outside the vault either: the editor on
    // the other end was handed an empty body, so saving it would erase the note.
    if (note.Secure) return Results.Json(
        new { error = "The owner locked this note." }, statusCode: StatusCodes.Status410Gone);

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
    await hub.Clients.User(ownerUid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
    return Results.NoContent();
}

// Replace targetDir's contents with sourceDir's, keeping targetDir itself (so a
// live FileSystemWatcher on it stays valid). Clears the target first, then mirrors
// the source tree in. A missing source tree just leaves the target empty.
// Delete a directory tree even when it holds read-only files — git marks its
// object files read-only, and Directory.Delete refuses those on Windows.
static void DeleteDirectoryForce(string dir)
{
    if (!Directory.Exists(dir)) return;
    foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        File.SetAttributes(file, FileAttributes.Normal);
    Directory.Delete(dir, recursive: true);
}

// Rebuild one tenant's cache and index from the .md files after a restore (the
// files are the authority). Notes the restore removed fall out when the watcher
// fires their deletes; this makes the restored set visible immediately.
static async Task<int> RescanUserAsync(
    string uid, IConfiguration config, IHostEnvironment env, VaultState state, MarkdownStorageService storage,
    SearchIndexService search, VaultObserver observer, IHubContext<NotesHub> hub, CancellationToken ct)
{
    await hub.Clients.All.SendAsync("SystemRebuilding", ct);
    observer.WatchUser(uid); // ensures the dir exists + is watched (no-op if so)
    var notesDir = PapyraPaths.UserNotesDir(config, env.ContentRootPath, uid);
    var scanned = new List<Note>();
    foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
    {
        if (ConflictDetector.IsConflict(Path.GetFileName(path))) continue;
        var note = await storage.ReadAsync(path, ct);
        if (note is null || string.IsNullOrEmpty(note.Id)) continue;
        state.Upsert(uid, path, note);
        scanned.Add(note);
    }
    search.RebuildUser(uid, scanned);
    return scanned.Count;
}

// Validate an SMTP form into setting rows. Shared by the admin page and setup.
static (Dictionary<string, string?>? Values, string? Problem) SmtpValues(SmtpConfigWrite body)
{
    var enabled = body.Enabled == true;
    var host = body.Host?.Trim() ?? string.Empty;
    var from = body.FromAddress?.Trim() ?? string.Empty;

    if (enabled && (host.Length == 0 || from.Length == 0))
        return (null, "Host and From address are required to enable email.");
    if (from.Length > 0 && !MailAddress.TryCreate(from, out _))
        return (null, "From address is not a valid email address.");
    var port = body.Port ?? 587;
    if (port is < 1 or > 65535)
        return (null, "Port must be between 1 and 65535.");
    if (body.PublicUrl is { Length: > 0 } url && !Uri.TryCreate(url, UriKind.Absolute, out _))
        return (null, "Public URL must be an absolute URL.");

    var values = new Dictionary<string, string?>
    {
        [SmtpKeys.Enabled] = enabled ? "true" : "false",
        [SmtpKeys.Host] = host,
        [SmtpKeys.Port] = port.ToString(),
        [SmtpKeys.UseSsl] = body.UseSsl == true ? "true" : "false",
        [SmtpKeys.Username] = body.Username?.Trim() ?? string.Empty,
        [SmtpKeys.FromAddress] = from,
        [SmtpKeys.FromName] = body.FromName?.Trim() ?? string.Empty,
        [SmtpKeys.PublicUrl] = body.PublicUrl?.Trim() ?? string.Empty,
    };
    if (body.Password is not null) values[SmtpKeys.Password] = body.Password;
    return (values, null);
}

// Only hashes of one-time codes are stored. The email-change code is bound to the
// address being moved to, so a code for one address can't confirm another.
static string EmailChangeCodeHash(int userId, string newEmail, string code) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes($"email-change:{userId}:{newEmail.Trim().ToLowerInvariant()}:{code.Trim()}")));

static string SetupCodeHash(string email, string code) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes($"setup-email:{email.Trim().ToLowerInvariant()}:{code.Trim()}")));

static string SetupTotpHash(string secret) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes($"setup-totp:{secret.Trim().ToUpperInvariant()}")));

static async Task<AuthToken?> LiveSetupCodeAsync(AppDbContext db, string? email, string? code, CancellationToken ct)
{
    if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(code)) return null;
    var hash = SetupCodeHash(email, code);
    var row = await db.AuthTokens.FirstOrDefaultAsync(t => t.Kind == "setup-email" && t.TokenHash == hash, ct);
    return row is null || row.UsedUtc is not null || row.ExpiresUtc < DateTime.UtcNow ? null : row;
}

// Where a backup waits between /setup/restore and /setup. Instance-level Papyra
// state, never inside a vault.
static string SetupStagingRoot(IConfiguration config, IHostEnvironment env) =>
    Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "setup-restore");

// A new account password re-seals an encrypted git backup's data key, so the
// password that unlocks the backup is always the one the person uses today.
// The repository picks up the new header on the next sync. Caller saves.
static async Task RewrapGitBackupKeyAsync(AppDbContext db, GitSyncService git, string uid, string newPassword, CancellationToken ct)
{
    var keys = new[] { GitKeys.Mode(uid), GitKeys.DataKey(uid), GitKeys.Crypto(uid) };
    var rows = await db.Settings.Where(s => keys.Contains(s.Key)).ToDictionaryAsync(s => s.Key, ct);
    if (rows.GetValueOrDefault(GitKeys.Mode(uid))?.Value != "encrypted") return;
    if (rows.GetValueOrDefault(GitKeys.DataKey(uid)) is not { Value: { Length: > 0 } sealedKey }) return;
    var key = git.UnprotectKey(sealedKey);
    try
    {
        var header = System.Text.Json.JsonSerializer.Serialize(EncryptedGitCodec.Wrap(key, newPassword), GitSyncService.JsonOpts);
        if (rows.GetValueOrDefault(GitKeys.Crypto(uid)) is { } row) row.Value = header;
        else db.Settings.Add(new AppSetting { Key = GitKeys.Crypto(uid), Value = header });
    }
    finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
}

// Download a git backup and leave it, readable, at destPlain: cloned, located
// (current layout or the older whole-directory mirror), and decrypted when it is
// an encrypted one. Returns a plain-language error (and a code the SPA can act
// on: password_required / password_wrong), or how it was stored.
static async Task<(string? Error, string? Code, GitRestoreSource? Source)> StageGitBackupAsync(
    string remote, string branch, string? token, string? password, string destPlain, GitSyncService git, CancellationToken ct)
{
    var checkout = destPlain + "-checkout";
    try
    {
        var problem = await Task.Run(() => GitSyncService.CloneForRestore(remote, branch, token, checkout), ct);
        if (problem is not null) return (problem, "git_failed", null);
        if (BackupLayout.LocateRoot(checkout) is not { } root)
            return ("That repository doesn't hold a Papyra backup.", "not_a_backup", null);

        var manifest = BackupLayout.ReadManifest(root);
        if (manifest?.Encrypted == true)
        {
            if (manifest.Crypto is null) return ("That backup is encrypted but its key header is missing.", "not_a_backup", null);
            if (string.IsNullOrEmpty(password))
                return ("This backup is encrypted. Enter the Papyra password it was made with.", "password_required", null);
            byte[] key;
            try { key = EncryptedGitCodec.Unwrap(manifest.Crypto, password); }
            catch (System.Security.Cryptography.CryptographicException)
            { return ("That password doesn't unlock this backup.", "password_wrong", null); }
            catch (FormatException)
            { return ("That backup's key header is damaged.", "not_a_backup", null); }
            try
            {
                Directory.CreateDirectory(destPlain);
                EncryptedGitCodec.DecryptTree(root, destPlain, key);
                await File.WriteAllTextAsync(Path.Combine(destPlain, BackupManifest.FileName), System.Text.Json.JsonSerializer.Serialize(
                    manifest with { Encrypted = false, Crypto = null }, GitSyncService.JsonOpts), ct);
                return (null, null, new GitRestoreSource("encrypted", git.ProtectKey(key),
                    System.Text.Json.JsonSerializer.Serialize(manifest.Crypto, GitSyncService.JsonOpts)));
            }
            catch (System.Security.Cryptography.CryptographicException)
            { return ("Part of that backup is damaged or was changed outside Papyra.", "damaged", null); }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
        }

        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(root, file);
            if (rel.StartsWith(".git", StringComparison.Ordinal)) continue;
            var target = Path.Combine(destPlain, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
        return (null, null, new GitRestoreSource("plain", null, null));
    }
    finally
    {
        DeleteDirectoryForce(checkout);
    }
}

// Point an account's git backup at a repository it was just restored from, in the
// same mode, with a fresh local mirror (which adopts the repository's history on
// its first pass). An encrypted backup keeps its data key; when the account's
// password is given the key is re-sealed under it.
static async Task SaveGitBackupConfigAsync(
    AppDbContext db, GitSyncService git, string uid, string remote, string branch, string? token,
    GitRestoreSource source, string? rewrapPassword, IConfiguration config, IHostEnvironment env, CancellationToken ct)
{
    async Task Set(string key, string value)
    {
        var row = await db.Settings.FindAsync([key], ct);
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = value });
        else row.Value = value;
    }

    await Set(GitKeys.RemoteUrl(uid), remote);
    await Set(GitKeys.Branch(uid), branch);
    if (!string.IsNullOrEmpty(token)) await Set(GitKeys.Token(uid), token);
    await Set(GitKeys.Mode(uid), source.Mode);
    await Set(GitKeys.DataKey(uid), source.SealedKey ?? string.Empty);
    await Set(GitKeys.Crypto(uid), source.HeaderJson ?? string.Empty);
    await Set(GitKeys.Conflict(uid), string.Empty);
    await Set(GitKeys.LastError(uid), string.Empty);
    if (source.Mode == "encrypted" && !string.IsNullOrEmpty(rewrapPassword)) await db.SaveChangesAsync(ct);
    if (source.Mode == "encrypted" && !string.IsNullOrEmpty(rewrapPassword))
        await RewrapGitBackupKeyAsync(db, git, uid, rewrapPassword, ct);
    await db.SaveChangesAsync(ct);

    var mirror = PapyraPaths.UserGitMirrorDir(config, env.ContentRootPath, uid);
    if (Directory.Exists(mirror)) DeleteDirectoryForce(mirror);
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

// The refusal for a disabled account. Only ever given after the credential
// checked out, so it never tells a stranger whether an account exists.
static IResult AccountDisabled() => Results.Json(
    new { error = "This account has been disabled. Ask your Papyra administrator.", code = "account_disabled" },
    statusCode: StatusCodes.Status403Forbidden);

// SQLite hands DateTime back unmarked; the API always means UTC.
static DateTime? AsUtc(DateTime? value) => value is { } v ? DateTime.SpecifyKind(v, DateTimeKind.Utc) : null;

// When/browser/address rows for a security email about something done in a request.
static EmailDetail[] RequestDetails(User user, HttpContext http) =>
[
    new("When", SignInNotices.When(user, DateTime.UtcNow)),
    new("Browser", SignInNotices.Describe(http.Request.Headers.UserAgent.ToString())),
    new("Address", http.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
];

// Admins who could still run the instance if this one stopped being one.
static Task<int> ActiveAdminsOtherThan(AppDbContext db, int userId, CancellationToken ct) =>
    db.Users.CountAsync(u => u.Role == "Admin" && u.Id != userId && u.DisabledUtc == null && u.DeletionScheduledUtc == null, ct);

// Account changes are told to the admins who didn't make them — two people
// running one server should each know when the other locks someone out.
static async Task TellOtherAdmins(
    AppDbContext db, EmailSender email, int actorId, string subject, string body, CancellationToken ct, int? exceptUserId = null)
{
    var admins = await db.Users
        .Where(u => u.Role == "Admin" && u.Id != actorId && u.Id != exceptUserId && u.DisabledUtc == null)
        .ToListAsync(ct);
    foreach (var a in admins)
        await email.NotifyAsync(a, NotificationCatalog.AdminAccountChanges, subject, body, ct: ct);
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
// The server's own zone as an IANA id — what a Docker container's TZ sets. On
// Windows (development) the local zone has a Windows id; browsers want IANA.
static string ServerTimeZoneId()
{
    var local = TimeZoneInfo.Local;
    if (local.HasIanaId) return local.Id;
    return TimeZoneInfo.TryConvertWindowsIdToIanaId(local.Id, out var iana) ? iana : "UTC";
}

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

// First-admin bootstrap payload. Username + password required; the rest is the
// guided setup: a verified email (the code from POST /setup/email/code), the
// vault PIN, time zone, theme, and a staged backup to restore into the account.
public sealed record SetupRequest(
    string? Username,
    string? Name,
    string? Email,
    string? Password,
    string? EmailCode = null,
    string? Pin = null,
    string? TimeZone = null,
    string? Theme = null,
    string? RestoreId = null,
    string? TotpSecret = null,
    string? TotpCode = null);

public sealed record SetupEmailCodeRequest(string? Email);
public sealed record SetupEmailVerifyRequest(string? Email, string? Code);
public sealed record SetupTotpRequest(string? Account);
public sealed record TotpVerifyRequest(string? Secret, string? Code);
public sealed record TotpEnableRequest(string? Secret, string? Code, string? Password);
public sealed record TotpRemoveRequest(string? Password);

// A backup staged by POST /api/auth/setup/restore, waiting for POST /setup.
public sealed record SetupRestoreMeta(
    string? RemoteUrl, string? Branch, string? Token, string? Mode, string? SealedKey, string? HeaderJson);

// How a git backup being restored is stored: "plain", or "encrypted" with its data
// key (sealed for this server) and the repository key header (JSON).
public sealed record GitRestoreSource(string Mode, string? SealedKey, string? HeaderJson);
/// <param name="ViaEmail">Send the code by email even though an authenticator is set up.</param>
public sealed record EmailCodeRequest(string? Email, bool ViaEmail = false);

// Restore from a git backup: where it is, how to read it (the password it was
// sealed with, when encrypted), and whether to keep backing up there afterwards.
public sealed record GitRestoreRequest(
    string? RemoteUrl, string? Branch, string? Token, string? Password,
    bool KeepSyncing = true, string? AccountPassword = null);

// Login payload. Both required; failures answer with a generic 401.
public sealed record LoginRequest(
    string? Username,
    string? Password);

// Admin-provisioned user. Username is required; a blank Password means "generate
// one". Role defaults to "User". SendEmail mails the sign-in details, which needs
// an address and configured SMTP.
public sealed record ProvisionRequest(
    string? Username,
    string? Name,
    string? Email,
    string? Password,
    string? Role,
    bool? SendEmail = null);

// Admin password reset payload. A blank Password means "generate one".
public sealed record ResetRequest(
    string? Password,
    bool? SendEmail = null);

// Admin request for a one-time reset link on someone else's account.
public sealed record RecoveryLinkRequest(bool? SendEmail = null);

// Self-service profile update (display name + email).
// Every field optional: null = leave it as it is (older clients send no username).
public sealed record ProfileRequest(
    string? Name, string? Email, string? Username = null, string? TimeZone = null,
    string? Theme = null, string? EmailCode = null, string? CurrentPassword = null, string? TotpCode = null);

// Self-service password change: verify Current, set Next.
public sealed record PasswordRequest(string? Current, string? Next);

// Admin SSO configuration payload. ClientSecret is null when the admin left the
// field blank, which means "keep whatever is stored".
public sealed record OidcConfigWrite(
    bool? Enabled, string? Authority, string? ClientId, string? ClientSecret, string? DisplayName);

// Admin SMTP configuration. Password is null when left blank (keep the stored one).
public sealed record SmtpConfigWrite(
    bool? Enabled, string? Host, int? Port, bool? UseSsl, string? Username, string? Password,
    string? FromAddress, string? FromName, string? PublicUrl);

// Optional override for the test-send recipient; defaults to the admin's own address.
public sealed record SmtpTestRequest(string? To);

// Admin AI configuration. A null key means "leave the stored one alone"; an empty
// string clears it. Same write-only contract as the SSO and SMTP secrets.
public sealed record AiConfigWrite(
    string? ChatProvider, string? EmbedProvider,
    string? OllamaBaseUrl, string? OllamaChatModel, string? OllamaEmbedModel,
    string? OpenAiBaseUrl, string? OpenAiChatModel, string? OpenAiEmbedModel, string? OpenAiKey,
    string? AnthropicChatModel, string? AnthropicKey);

// Which model to pull into Ollama. Validated against the curated download list.
public sealed record AiPullRequest(string? Model);

// Admin invitation: reserve a username for an address until the invitee sets a password.
public sealed record InviteRequest(string? Username, string? Email, string? Role);

// "I forgot my password" — accepts either the username or the email address.
public sealed record ForgotPasswordRequest(string? UsernameOrEmail);

// Redeem a reset or invite token by setting a password.
public sealed record ResetPasswordRequest(string? Token, string? Password);

// Which courtesy emails a user wants. Security mail is not listed: it is not optional.
public sealed record RoleChangeRequest(string? Role);
public sealed record DisableRequest(string? Reason);
public sealed record NotificationSwitch(string? Id, bool Enabled, string? Channel = null);
public sealed record NotificationPrefsWrite(bool? Mention, bool? Share, NotificationSwitch[]? Events = null);

// One mention-typeahead row. Deliberately just these two fields: the handle you
// have to type to ping someone, and enough to tell two similar handles apart.
public sealed record UserSuggestion(string Username, string Name);

// API key creation payload (just a human label).
public sealed record ApiKeyWrite(string? Name);

// Webhook registration: which event, the target URL, and an optional shared secret
// (one is generated + returned once if omitted).
public sealed record WebhookWrite(string? Event, string? Url, string? Secret);

// Git-sync config. Token is write-only (null leaves the stored one untouched).
// Mode: "plain" | "encrypted" (null keeps the current one). Turning encryption on
// needs the account password, which becomes the backup's unlock.
public sealed record GitConfigWrite(string? RemoteUrl, string? Branch, string? Token, string? Mode = null, string? Password = null);

// Smart-collection creation: a display name + the serialized AND/OR rule set.
public sealed record SmartCollectionWrite(string? Name, string? RulesJson);

// Set/change the vault PIN, with one proof of ownership (see POST /api/auth/vault/pin).
public sealed record VaultPinSetRequest(string? Pin, string? CurrentPin = null, string? Password = null);
public sealed record VaultUnlockRequest(string? Pin);

// WebAuthn enrolment: the browser's attestation response + a friendly device label.
public sealed record WebAuthnRegisterRequest(
    Fido2NetLib.AuthenticatorAttestationRawResponse? Response, string? Name);

// A question asked of the vault via retrieval-augmented chat.
/// <summary>
/// A question, optionally continuing an existing conversation. A null SessionId
/// starts a new one, which is what the panel sends on its first question.
/// </summary>
public sealed record AiChatRequest(string? Question, int? SessionId = null);

/// <summary>Rename a conversation.</summary>
public sealed record ChatSessionRename(string? Title);

// WebAuthn unlock: the browser's assertion response.
public sealed record WebAuthnAssertRequest(Fido2NetLib.AuthenticatorAssertionRawResponse? Response);
public sealed record PasskeyOptionsRequest(string? Username);
public sealed record ExportAuthorizeRequest(string? Password);
public sealed record AccountDeletePassword(string? Password);
public sealed record AccountDeleteRequest(string? Password, string? Code, string? ConfirmUsername);
public sealed record PasskeyVerifyRequest(string? Username, Fido2NetLib.AuthenticatorAssertionRawResponse? Response);

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
public sealed record AccessRequestWrite(int? ShareId, int? InboxId, string? Access, int? NotificationId = null);
public sealed record AccessDecision(string? Access);

// Trash retention update: how many days a trashed note survives (-1/0/3/7/30/60).
public sealed record SettingsRequest(int TrashRetentionDays);

// Conflict resolution choice: "left" (keep parent), "right" (keep the copy),
// or "both" (promote the copy to a new note). The rejected .md is deleted either way.
public sealed record ResolveConflictRequest(
    string? Keep);

// Makes the implicit top-level Program class visible to WebApplicationFactory in integration tests.
public partial class Program { }

// Multi-select: a flag change applied to many notes at once.
public sealed record BulkNoteAction(List<string>? Ids, string? Action)
{
    // Generous for a person selecting cards; a guard against a runaway client.
    public const int MaxIds = 1000;
}

// Multi-select: share many notes with one user.
public sealed record BulkShareWrite(List<string>? NoteIds, string? GranteeUsername, string? Access);
