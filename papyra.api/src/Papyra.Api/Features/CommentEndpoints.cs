using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Collab;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

public sealed record CommentQuote(string? Exact, string? Prefix, string? Suffix);
public sealed record CommentCreate(string? Body, CommentQuote? Quote, int? ThreadId);
public sealed record CommentEdit(string? Body);
public sealed record CommentResolve(bool Resolved);
public sealed record CommentReact(string? Emoji);

/// <summary>
/// Comments on notes (see <see cref="NoteComment"/>): threads anchored to a
/// passage, replies, @mentions, reactions, resolve/reopen.
///
/// A note is addressed the way the live room addresses it — <c>?note=</c> for
/// your own, <c>?share=</c> for one shared with you — and every call re-checks
/// that the caller can still see it. Anyone who can see a note may comment on
/// it; editing and deleting a comment is its author's (the note's owner may
/// also delete, to moderate); resolving is for the owner, editors and the
/// thread's author. Locked notes take no comments: a quoted passage would put
/// words the vault withholds into the database.
/// </summary>
public static partial class CommentEndpoints
{
    public const int MaxBody = 4000;
    private const int MaxQuote = 500;
    private const int MaxContext = 64;

    /// <summary>The reaction set, as in most chat and docs tools.</summary>
    public static readonly string[] Reactions = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

    [GeneratedRegex(@"(?<![\w@])@([A-Za-z0-9_.\-]{1,64})")]
    private static partial Regex MentionPattern();

    public static void MapComments(this WebApplication app)
    {
        var group = app.MapGroup("/api/comments").RequireAuthorization().WithTags("Comments");
        group.MapGet("/", List).WithSummary("A note's comment threads");
        group.MapPost("/", Create).WithSummary("Start a thread, or reply to one");
        group.MapPut("/{id:int}", Edit).WithSummary("Edit your comment");
        group.MapDelete("/{id:int}", Delete).WithSummary("Delete a comment (a thread's first comment deletes the thread)");
        group.MapPost("/{id:int}/resolve", Resolve).WithSummary("Resolve or reopen a thread");
        group.MapPost("/{id:int}/reactions", React).WithSummary("Toggle an emoji reaction");
    }

    private sealed record Target(int OwnerId, string NoteId, string Access);

    private static int Me(ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    /// <summary>The note, if the caller can see it and it can take comments; else why not.</summary>
    private static async Task<(Target? Target, IResult? Refusal)> ResolveAsync(
        AppDbContext db, VaultState state, MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf,
        int uid, string? noteId, int? shareId, CancellationToken ct)
    {
        var access = await CollabAccess.ResolveAsync(db, uid, noteId, shareId, ct);
        if (access is null) return (null, Results.NotFound());
        return await CheckNoteAsync(state, storage, vault, lf, new Target(access.OwnerId, access.NoteId,
            access.OwnerId == uid ? "owner" : access.Access), ct);
    }

    /// <summary>The same checks for a comment's own note, by the caller's current access.</summary>
    private static async Task<(Target? Target, IResult? Refusal)> ResolveForCommentAsync(
        AppDbContext db, VaultState state, MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf,
        int uid, NoteComment comment, CancellationToken ct)
    {
        string? access = comment.OwnerId == uid ? "owner" : await db.Shares
            .Where(s => s.OwnerId == comment.OwnerId && s.NoteId == comment.NoteId && s.Kind == "user" && s.GranteeUserId == uid)
            .Select(s => s.Access).FirstOrDefaultAsync(ct);
        if (access is null) return (null, Results.NotFound());
        return await CheckNoteAsync(state, storage, vault, lf, new Target(comment.OwnerId, comment.NoteId, access), ct);
    }

    private static async Task<(Target?, IResult?)> CheckNoteAsync(
        VaultState state, MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, Target target, CancellationToken ct)
    {
        var note = await storage.ReadAsync(
            CollabEndpoints.OwnerNotePath(state, vault, lf, target.OwnerId.ToString(), target.NoteId), ct);
        if (note is null || note.Trashed) return (null, Results.NotFound());
        if (note.Secure) return (null, Results.Json(
            new { error = "Locked notes can’t take comments.", code = "locked" }, statusCode: StatusCodes.Status409Conflict));
        return (target, null);
    }

    /// <summary>Everyone who can see the note: its owner and the people it is shared with.</summary>
    private static async Task<List<int>> AudienceAsync(AppDbContext db, Target t, CancellationToken ct)
    {
        var people = await db.Shares
            .Where(s => s.OwnerId == t.OwnerId && s.NoteId == t.NoteId && s.Kind == "user" && s.GranteeUserId != null)
            .Select(s => s.GranteeUserId!.Value).ToListAsync(ct);
        people.Add(t.OwnerId);
        return people.Distinct().ToList();
    }

    private static async Task Changed(IHubContext<NotesHub> hub, IEnumerable<int> audience, Target t, CancellationToken ct)
    {
        foreach (var uid in audience)
            await hub.Clients.User(uid.ToString()).SendAsync("CommentsChanged", new { ownerId = t.OwnerId, noteId = t.NoteId }, ct);
    }

    private static async Task<IResult> List(
        string? note, int? share, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, CancellationToken ct)
    {
        var uid = Me(user);
        var (target, refusal) = await ResolveAsync(db, state, storage, vault, lf, uid, note, share, ct);
        if (target is null) return refusal!;

        var rows = await db.NoteComments.Where(c => c.OwnerId == target.OwnerId && c.NoteId == target.NoteId)
            .OrderBy(c => c.CreatedUtc).ThenBy(c => c.Id).ToListAsync(ct);
        var ids = rows.Select(c => c.Id).ToList();
        var reactions = await db.CommentReactions.Where(r => ids.Contains(r.CommentId))
            .OrderBy(r => r.CreatedUtc).ToListAsync(ct);
        var audience = await AudienceAsync(db, target, ct);
        var userIds = rows.Select(c => c.AuthorId)
            .Concat(rows.Where(c => c.ResolvedById != null).Select(c => c.ResolvedById!.Value))
            .Concat(reactions.Select(r => r.UserId)).Concat(audience).Append(uid).ToHashSet();
        var users = await db.Users.Where(u => userIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => new { u.Id, u.Username, u.Name }, ct);
        object Person(int id) => users.TryGetValue(id, out var u)
            ? new { u.Id, u.Username, name = string.IsNullOrWhiteSpace(u.Name) ? u.Username : u.Name }
            : new { Id = id, Username = "deleted", name = "Deleted user" };

        var canModerate = target.Access is "owner";
        var threads = rows.Where(c => c.ThreadId is null).Select(root =>
        {
            var replies = rows.Where(c => c.ThreadId == root.Id);
            return new
            {
                root.Id,
                quote = root.QuoteExact is null ? null : new { exact = root.QuoteExact, prefix = root.QuotePrefix ?? "", suffix = root.QuoteSuffix ?? "" },
                resolved = root.ResolvedUtc is not null,
                resolvedUtc = Utc(root.ResolvedUtc),
                resolvedBy = root.ResolvedById is { } rb ? Person(rb) : null,
                createdUtc = Utc(root.CreatedUtc),
                canResolve = target.Access is "owner" or "edit" || root.AuthorId == uid,
                comments = new[] { root }.Concat(replies).Select(c => new
                {
                    c.Id,
                    author = Person(c.AuthorId),
                    c.Body,
                    createdUtc = Utc(c.CreatedUtc),
                    editedUtc = Utc(c.EditedUtc),
                    canEdit = c.AuthorId == uid,
                    canDelete = c.AuthorId == uid || canModerate,
                    reactions = reactions.Where(r => r.CommentId == c.Id).GroupBy(r => r.Emoji)
                        .OrderBy(g => Array.IndexOf(Reactions, g.Key))
                        .Select(g => new
                        {
                            emoji = g.Key,
                            count = g.Count(),
                            mine = g.Any(r => r.UserId == uid),
                            people = g.Select(r => users.TryGetValue(r.UserId, out var u) ? u.Username : "deleted").ToList(),
                        }),
                }),
            };
        });
        return Results.Ok(new
        {
            ownerId = target.OwnerId,
            noteId = target.NoteId,
            me = Person(uid),
            reactions = Reactions,
            // Who a comment can @mention: the people who can read it.
            people = audience.Where(users.ContainsKey).Select(Person),
            threads,
        });
    }

    private static DateTime? Utc(DateTime? t) => t is { } v ? DateTime.SpecifyKind(v, DateTimeKind.Utc) : null;

    private static string? BodyProblem(string? body) =>
        string.IsNullOrWhiteSpace(body) ? "Write something first."
        : body.Length > MaxBody ? $"Keep a comment under {MaxBody} characters." : null;

    private static string? Clip(string? s, int max, bool fromEnd = false) =>
        s is null ? null : s.Length <= max ? s : fromEnd ? s[^max..] : s[..max];

    private static async Task<IResult> Create(
        string? note, int? share, CommentCreate body, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, IHubContext<NotesHub> hub,
        EmailSender email, HttpContext http, CancellationToken ct)
    {
        var uid = Me(user);
        var (target, refusal) = await ResolveAsync(db, state, storage, vault, lf, uid, note, share, ct);
        if (target is null) return refusal!;
        if (BodyProblem(body.Body) is { } bad) return Results.BadRequest(new { error = bad });

        NoteComment? root = null;
        if (body.ThreadId is { } threadId)
        {
            root = await db.NoteComments.FirstOrDefaultAsync(c => c.Id == threadId && c.ThreadId == null
                && c.OwnerId == target.OwnerId && c.NoteId == target.NoteId, ct);
            if (root is null) return Results.NotFound(new { error = "That thread is gone." });
        }
        var exact = body.Quote?.Exact;
        if (root is null && exact is { Length: > MaxQuote })
            return Results.BadRequest(new { error = $"Select less text — up to {MaxQuote} characters." });

        var comment = new NoteComment
        {
            OwnerId = target.OwnerId, NoteId = target.NoteId, ThreadId = root?.Id, AuthorId = uid,
            Body = body.Body!.Trim(),
            QuoteExact = root is null && !string.IsNullOrWhiteSpace(exact) ? exact : null,
            QuotePrefix = root is null ? Clip(body.Quote?.Prefix, MaxContext, fromEnd: true) : null,
            QuoteSuffix = root is null ? Clip(body.Quote?.Suffix, MaxContext) : null,
            CreatedUtc = DateTime.UtcNow,
        };
        db.NoteComments.Add(comment);
        // Replying to a resolved thread reopens it, as in Docs.
        if (root is not null && root.ResolvedUtc is not null) { root.ResolvedUtc = null; root.ResolvedById = null; }
        await db.SaveChangesAsync(ct);

        var audience = await AudienceAsync(db, target, ct);
        await NotifyAsync(db, hub, email, http, target, audience, comment, root, ct);
        await Changed(hub, audience, target, ct);
        return Results.Ok(new { comment.Id, threadId = comment.ThreadId ?? comment.Id });
    }

    /// <summary>
    /// Who hears about a new comment, most specific reason first (one entry each):
    /// people it @mentions, then the thread's earlier participants, then the
    /// note's owner. Only people who can see the note; never its author.
    /// </summary>
    private static async Task NotifyAsync(
        AppDbContext db, IHubContext<NotesHub> hub, EmailSender email, HttpContext http, Target target,
        List<int> audience, NoteComment comment, NoteComment? root, CancellationToken ct)
    {
        var told = new Dictionary<int, string>();
        var handles = MentionPattern().Matches(comment.Body).Select(m => m.Groups[1].Value.ToLowerInvariant()).ToHashSet();
        if (handles.Count > 0)
        {
            var mentioned = await db.Users.Where(u => handles.Contains(u.Username.ToLower())).Select(u => u.Id).ToListAsync(ct);
            foreach (var id in mentioned.Where(audience.Contains)) told.TryAdd(id, "comment_mention");
        }
        if (root is not null)
        {
            var participants = await db.NoteComments.Where(c => c.Id == root.Id || c.ThreadId == root.Id)
                .Select(c => c.AuthorId).Distinct().ToListAsync(ct);
            foreach (var id in participants.Where(audience.Contains)) told.TryAdd(id, "comment_reply");
        }
        told.TryAdd(target.OwnerId, "comment");
        told.Remove(comment.AuthorId);
        if (told.Count == 0) return;

        var now = DateTime.UtcNow;
        foreach (var (id, kind) in told)
            db.Notifications.Add(new Notification
            {
                UserId = id, Kind = kind, ActorUserId = comment.AuthorId, OwnerId = target.OwnerId,
                NoteId = target.NoteId, CommentId = comment.Id, CreatedUtc = now,
            });
        await db.SaveChangesAsync(ct);

        var author = await db.Users.Where(u => u.Id == comment.AuthorId).Select(u => u.Username).FirstAsync(ct);
        var recipients = await db.Users.Where(u => told.Keys.Contains(u.Id)).ToListAsync(ct);
        var url = email.PublicUrl($"{http.Request.Scheme}://{http.Request.Host}");
        foreach (var r in recipients)
        {
            await hub.Clients.User(r.Id.ToString()).SendAsync("NotificationsChanged", ct);
            if (!email.IsConfigured || !NotificationPrefs.Wants(r, NotificationCatalog.Comments)) continue;
            var subject = told[r.Id] switch
            {
                "comment_mention" => $"@{author} mentioned you in a comment",
                "comment_reply" => $"@{author} replied to a comment",
                _ => $"@{author} commented on your note",
            };
            // The comment, not the note: the note body never leaves Papyra by mail.
            await email.NotifyAsync(r, NotificationCatalog.Comments, subject,
                $"{subject}:\n\n“{Clip(comment.Body, 400)}”\n\nReply in Papyra: {url}/?notifications=1", ct: ct);
        }
    }

    private static async Task<IResult> Edit(
        int id, CommentEdit body, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, IHubContext<NotesHub> hub, CancellationToken ct)
    {
        var uid = Me(user);
        var comment = await db.NoteComments.FindAsync([id], ct);
        if (comment is null) return Results.NotFound();
        var (target, refusal) = await ResolveForCommentAsync(db, state, storage, vault, lf, uid, comment, ct);
        if (target is null) return refusal!;
        if (comment.AuthorId != uid) return Results.Json(new { error = "Only its author can edit a comment." }, statusCode: 403);
        if (BodyProblem(body.Body) is { } bad) return Results.BadRequest(new { error = bad });
        comment.Body = body.Body!.Trim();
        comment.EditedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await Changed(hub, await AudienceAsync(db, target, ct), target, ct);
        return Results.Ok(new { comment.Id });
    }

    private static async Task<IResult> Delete(
        int id, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, IHubContext<NotesHub> hub, CancellationToken ct)
    {
        var uid = Me(user);
        var comment = await db.NoteComments.FindAsync([id], ct);
        if (comment is null) return Results.NotFound();
        var (target, refusal) = await ResolveForCommentAsync(db, state, storage, vault, lf, uid, comment, ct);
        if (target is null) return refusal!;
        if (comment.AuthorId != uid && target.Access != "owner")
            return Results.Json(new { error = "Only its author or the note’s owner can delete a comment." }, statusCode: 403);

        // A thread's first comment takes the thread with it.
        var doomed = comment.ThreadId is null
            ? await db.NoteComments.Where(c => c.Id == id || c.ThreadId == id).ToListAsync(ct)
            : [comment];
        var ids = doomed.Select(c => c.Id).ToList();
        db.CommentReactions.RemoveRange(db.CommentReactions.Where(r => ids.Contains(r.CommentId)));
        // Their tray entries would point at nothing.
        db.Notifications.RemoveRange(db.Notifications.Where(n => n.CommentId != null && ids.Contains(n.CommentId.Value)));
        db.NoteComments.RemoveRange(doomed);
        await db.SaveChangesAsync(ct);
        await Changed(hub, await AudienceAsync(db, target, ct), target, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> Resolve(
        int id, CommentResolve body, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, IHubContext<NotesHub> hub, CancellationToken ct)
    {
        var uid = Me(user);
        var root = await db.NoteComments.FindAsync([id], ct);
        if (root is null || root.ThreadId is not null) return Results.NotFound();
        var (target, refusal) = await ResolveForCommentAsync(db, state, storage, vault, lf, uid, root, ct);
        if (target is null) return refusal!;
        if (target.Access is not ("owner" or "edit") && root.AuthorId != uid)
            return Results.Json(new { error = "Only the note’s editors or the thread’s author can resolve it." }, statusCode: 403);
        root.ResolvedUtc = body.Resolved ? DateTime.UtcNow : null;
        root.ResolvedById = body.Resolved ? uid : null;
        await db.SaveChangesAsync(ct);
        await Changed(hub, await AudienceAsync(db, target, ct), target, ct);
        return Results.Ok(new { root.Id, resolved = body.Resolved });
    }

    private static async Task<IResult> React(
        int id, CommentReact body, ClaimsPrincipal user, AppDbContext db, VaultState state,
        MarkdownStorageService storage, VaultObserverOptions vault, ILoggerFactory lf, IHubContext<NotesHub> hub, CancellationToken ct)
    {
        var uid = Me(user);
        if (body.Emoji is null || !Reactions.Contains(body.Emoji)) return Results.BadRequest(new { error = "Pick one of the reactions." });
        var comment = await db.NoteComments.FindAsync([id], ct);
        if (comment is null) return Results.NotFound();
        var (target, refusal) = await ResolveForCommentAsync(db, state, storage, vault, lf, uid, comment, ct);
        if (target is null) return refusal!;

        var existing = await db.CommentReactions.FirstOrDefaultAsync(r => r.CommentId == id && r.UserId == uid && r.Emoji == body.Emoji, ct);
        if (existing is null)
            db.CommentReactions.Add(new CommentReaction { CommentId = id, UserId = uid, Emoji = body.Emoji, CreatedUtc = DateTime.UtcNow });
        else
            db.CommentReactions.Remove(existing);
        await db.SaveChangesAsync(ct);
        await Changed(hub, await AudienceAsync(db, target, ct), target, ct);
        return Results.Ok(new { reacted = existing is null });
    }
}
