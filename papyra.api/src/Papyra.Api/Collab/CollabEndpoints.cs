using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Yarp.ReverseProxy.Forwarder;

namespace Papyra.Api.Collab;

public sealed record CollabTicketRequest(string? NoteId, int? ShareId);
public sealed record CollabSaveRequest(string Body, string BaseHash, string? YState, int[]? Contributors);

/// <summary>
/// HTTP surface of live collaboration:
/// <list type="bullet">
/// <item><c>POST /api/collab/ticket</c> — signed-in callers get a room ticket for a note they may open.</item>
/// <item><c>/collab</c> — the browser's WebSocket, proxied to the loopback engine.</item>
/// <item><c>/internal/collab/notes/{owner}/{note}</c> — the engine's only data path (load + hash-checked save),
///   guarded by the per-boot shared secret.</item>
/// </list>
/// </summary>
public static class CollabEndpoints
{
    /// <summary>Header a collaborative editor sets on metadata saves: keep the body on disk, the room owns it.</summary>
    public const string CollabClientHeader = "X-Papyra-Collab";

    public static IServiceCollection AddCollab(this IServiceCollection services, IConfiguration config)
    {
        var options = CollabOptions.From(config);
        services.AddSingleton(options);
        services.AddHttpClient(CollabEngine.HttpClientName, client => client.Timeout = TimeSpan.FromSeconds(30));
        services.AddSingleton<CollabEngine>();
        services.AddSingleton<ICollabEngine>(sp => sp.GetRequiredService<CollabEngine>());
        services.AddSingleton<CollabStateStore>();
        services.AddSingleton<NoteWriteLocks>();
        services.AddHttpForwarder();
        services.AddHostedService<CollabHost>();
        return services;
    }

    public static void MapCollab(this WebApplication app)
    {
        app.MapPost("/api/collab/ticket", IssueTicket).RequireAuthorization().WithTags("Collaboration")
            .WithSummary("Get a ticket to join a note's live editing room");

        var forwarderClient = new HttpMessageInvoker(new SocketsHttpHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
            ActivityHeadersPropagator = null,
            ConnectTimeout = TimeSpan.FromSeconds(10),
        });
        var proxy = async (HttpContext context, IHttpForwarder forwarder, ICollabEngine engine) =>
        {
            if (engine.Status != CollabStatus.Ok || engine.BaseUrl is null)
            {
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                return;
            }
            await forwarder.SendAsync(context, engine.BaseUrl.ToString().TrimEnd('/'), forwarderClient,
                new ForwarderRequestConfig { ActivityTimeout = TimeSpan.FromMinutes(30) }, StripCredentials.Instance);
        };
        app.Map("/collab", proxy).RequireAuthorization().ExcludeFromDescription();
        app.Map("/collab/{**rest}", proxy).RequireAuthorization().ExcludeFromDescription();

        var internalApi = app.MapGroup("/internal/collab").ExcludeFromDescription()
            .AddEndpointFilter(async (context, next) =>
            {
                var engine = context.HttpContext.RequestServices.GetRequiredService<ICollabEngine>();
                var given = context.HttpContext.Request.Headers["X-Collab-Secret"].ToString();
                // 404, not 403: nothing outside the container needs to learn this exists.
                return SecretMatches(given, engine.Secret) ? await next(context) : Results.NotFound();
            });
        internalApi.MapGet("/notes/{owner:int}/{noteId}", LoadNote);
        internalApi.MapPut("/notes/{owner:int}/{noteId}", SaveNote);
    }

    private static bool SecretMatches(string given, string secret) =>
        given.Length > 0 && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(given), Encoding.UTF8.GetBytes(secret));

    // ── Ticket ────────────────────────────────────────────────────────────────

    private static async Task<IResult> IssueTicket(
        CollabTicketRequest body, ClaimsPrincipal user, ICollabEngine engine, AppDbContext db,
        VaultState state, MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf,
        CancellationToken ct)
    {
        if (engine.Status != CollabStatus.Ok)
            return Results.Json(new { error = "Live editing is unavailable right now.", code = "collab_unavailable" },
                statusCode: StatusCodes.Status503ServiceUnavailable);

        var uid = int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var access = await CollabAccess.ResolveAsync(db, uid, body.NoteId, body.ShareId, ct);
        if (access is null) return Results.NotFound();

        var note = await ReadOwnerNoteAsync(state, storage, vault, lf, access.OwnerId.ToString(), access.NoteId, ct);
        if (note is null || note.Trashed) return Results.NotFound();
        // A locked note never enters a room: its body is withheld everywhere else.
        if (note.Secure) return Results.Json(new { error = "This note is locked.", code = "locked" },
            statusCode: StatusCodes.Status410Gone);

        var me = await db.Users.Where(u => u.Id == uid).Select(u => new { u.Name, u.Username }).FirstAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var ticket = new CollabTicket(1, uid, string.IsNullOrWhiteSpace(me.Name) ? me.Username : me.Name,
            access.OwnerId, access.NoteId, access.Access, now.ToUnixTimeMilliseconds(),
            now.Add(engine.TicketLifetime).ToUnixTimeSeconds());
        return Results.Ok(new
        {
            ticket = CollabTicket.Mint(engine.Secret, ticket),
            room = CollabTicket.RoomName(access.OwnerId, access.NoteId),
            access = access.Access,
            uid,
            username = me.Username,
            name = ticket.Name,
            url = "/collab",
        });
    }

    // ── Engine data path ──────────────────────────────────────────────────────

    private static async Task<IResult> LoadNote(
        int owner, string noteId, VaultState state, MarkdownStorageService storage, VaultObserverOptions vault,
        CollabStateStore states, ILoggerFactory lf, CancellationToken ct)
    {
        if (!PathGuard.IsValidNoteId(noteId)) return Results.NotFound();
        var ownerUid = owner.ToString();
        var note = await ReadOwnerNoteAsync(state, storage, vault, lf, ownerUid, noteId, ct);
        if (note is null || note.Trashed) return Results.NotFound();
        if (note.Secure) return Results.StatusCode(StatusCodes.Status410Gone);

        var saved = await states.ReadAsync(ownerUid, noteId, ct);
        return Results.Ok(new
        {
            body = note.Body,
            hash = CollabHash.Of(note.Body),
            yState = saved is null ? null : Convert.ToBase64String(saved.Value.State),
            yStateHash = saved?.Hash,
        });
    }

    private static async Task<IResult> SaveNote(
        int owner, string noteId, CollabSaveRequest body, HttpContext http, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, CollabStateStore states, WriteRing writeRing,
        SearchIndexService search, SnapshotService snapshots, WebArchiverService archiver,
        EmbeddingService embeddings, MentionDeliveryService mentions, AppDbContext db, IHubContext<NotesHub> hub,
        NoteWriteLocks writeLocks, IConfiguration config, IHostEnvironment env, ILoggerFactory lf, CancellationToken ct)
    {
        if (!PathGuard.IsValidNoteId(noteId)) return Results.NotFound();
        var ownerUid = owner.ToString();
        var path = OwnerNotePath(state, vault, lf, ownerUid, noteId);
        using var writeLock = await writeLocks.AcquireAsync(ownerUid, noteId, ct);
        var note = await storage.ReadAsync(path, ct);
        if (note is null || note.Trashed) return Results.NotFound();
        if (note.Secure) return Results.StatusCode(StatusCodes.Status410Gone);

        // Hash-checked write: the room merged against `BaseHash`; if the file has
        // moved on since (git sync, another editor), hand back what's there now
        // and let the engine merge again rather than overwrite it.
        var currentHash = CollabHash.Of(note.Body);
        if (!string.Equals(currentHash, body.BaseHash, StringComparison.Ordinal))
            return Results.Json(new { body = note.Body, hash = currentHash }, statusCode: StatusCodes.Status409Conflict);

        var saved = await states.ReadAsync(ownerUid, noteId, ct);
        // The version on disk came from outside the room (first save of a session,
        // or an external edit it just merged): always keep it in history.
        var externalPrior = saved?.Hash != currentHash;
        var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, ownerUid);
        var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, noteId, lf.CreateLogger("PathGuard"));
        await snapshots.CaptureAsync(noteSnapDir, path, ct, force: externalPrior);

        var prior = note.Body;
        note.Body = body.Body;
        note.Updated = DateTime.UtcNow;
        writeRing.Mark(path);
        await storage.WriteAsync(path, note, ct);
        state.Upsert(ownerUid, path, note);
        search.IndexNote(ownerUid, note);
        archiver.Enqueue(ownerUid, noteId, note.Body);
        embeddings.Enqueue(ownerUid, noteId, note.Body);

        var newHash = CollabHash.Of(note.Body);
        if (body.YState is { Length: > 0 } yState)
            await states.WriteAsync(ownerUid, noteId, Convert.FromBase64String(yState), newHash, ct);

        // Mentions go out from whoever typed them (the first contributor), else the owner.
        var authorId = body.Contributors is { Length: > 0 } c ? c[0] : owner;
        var author = await db.Users.Where(u => u.Id == authorId).Select(u => u.Username).FirstOrDefaultAsync(ct);
        mentions.Enqueue(ownerUid, author ?? ownerUid, noteId, note.Body, prior);

        await hub.Clients.User(ownerUid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
        var grantees = await db.Shares
            .Where(s => s.OwnerId == owner && s.NoteId == noteId && s.Kind == "user" && s.GranteeUserId != null)
            .Select(s => s.GranteeUserId!.Value.ToString()).Distinct().ToListAsync(ct);
        if (grantees.Count > 0)
            await hub.Clients.Users(grantees).SendAsync("SharedNoteUpdated", new { ownerId = owner, noteId }, ct);

        return Results.Ok(new { hash = newHash });
    }

    // ── Guards used by the classic write paths ───────────────────────────────

    /// <summary>
    /// A classic (non-live) body write to a note whose room is live would
    /// clobber everyone's work: refuse it. Unchanged bodies (metadata saves)
    /// always pass.
    /// </summary>
    public static async Task<IResult?> BodyWriteGuardAsync(
        ICollabEngine engine, string ownerUid, string noteId, string? currentBody, string newBody, CancellationToken ct)
    {
        if (engine.Status != CollabStatus.Ok || currentBody is null || currentBody == newBody) return null;
        if (!await engine.IsRoomActiveAsync(ownerUid, noteId, ct)) return null;
        return Results.Json(new
        {
            error = "Someone is editing this note live. Reopen it to join them.",
            code = "collab_active",
        }, statusCode: StatusCodes.Status409Conflict);
    }

    // ── Shared helpers ─────────────────────────────────────────────────────────

    internal static string OwnerNotePath(
        VaultState state, VaultObserverOptions vault, ILoggerFactory lf, string ownerUid, string noteId) =>
        state.PathFor(ownerUid, noteId)
        ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(ownerUid), $"{noteId}.md", lf.CreateLogger("PathGuard"));

    private static Task<Note?> ReadOwnerNoteAsync(
        VaultState state, MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf,
        string ownerUid, string noteId, CancellationToken ct) =>
        storage.ReadAsync(OwnerNotePath(state, vault, lf, ownerUid, noteId), ct);

    /// <summary>Forward the WebSocket upgrade, but never the caller's session cookie.</summary>
    private sealed class StripCredentials : HttpTransformer
    {
        public static readonly StripCredentials Instance = new();

        public override async ValueTask TransformRequestAsync(
            HttpContext httpContext, HttpRequestMessage proxyRequest, string destinationPrefix, CancellationToken ct)
        {
            await base.TransformRequestAsync(httpContext, proxyRequest, destinationPrefix, ct);
            proxyRequest.Headers.Remove("Cookie");
            proxyRequest.Headers.Remove("Authorization");
        }
    }
}

/// <summary>Who may open which note live: its owner, or a signed-in user it is shared with.</summary>
public sealed record CollabAccess(int OwnerId, string NoteId, string Access)
{
    public static async Task<CollabAccess?> ResolveAsync(
        AppDbContext db, int uid, string? noteId, int? shareId, CancellationToken ct)
    {
        if (shareId is { } id)
        {
            var now = DateTime.UtcNow;
            var share = await db.Shares.FirstOrDefaultAsync(
                s => s.Id == id && s.Kind == "user" && s.GranteeUserId == uid, ct);
            if (share is null || (share.ExpiresUtc is { } expires && expires <= now)) return null;
            return new CollabAccess(share.OwnerId, share.NoteId, share.Access == "edit" ? "edit" : "view");
        }
        if (string.IsNullOrWhiteSpace(noteId) || !PathGuard.IsValidNoteId(noteId)) return null;
        return new CollabAccess(uid, noteId, "edit");
    }
}
