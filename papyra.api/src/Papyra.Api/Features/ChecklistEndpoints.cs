using System.Security.Claims;
using Papyra.Api.Collab;
using Papyra.Api.Data;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

public sealed record ChecklistTick(int Index, string? Text, bool Checked);

/// <summary>
/// A to-do list shown inside a journal day (<c>![[Title#^checklist]]</c>) is the
/// real to-do: ticking its boxes there ticks them in the to-do note itself. The
/// day's file only stores the reference. The write is the same careful one a
/// sections edit makes: under the note's write lock, a snapshot first, merged
/// into the live room when someone has the to-do open, and the item named by
/// its index *and* its text so a list that changed since it was drawn is never
/// mis-ticked (409 <c>stale</c> with the list as it is now). Locked to-dos are
/// refused (401), as are API keys — an embed is the app's.
/// </summary>
public static class ChecklistEndpoints
{
    public static void MapChecklist(this WebApplication app)
    {
        var g = app.MapGroup("/api/notes").RequireAuthorization().WithTags("Notes");
        g.MapGet("/{id}/checklist", Read).WithSummary("A to-do's items")
            .WithDescription("The to-do's checklist items in order — what a journal day draws when it embeds the list.");
        g.MapPost("/{id}/checklist/check", Check).WithSummary("Tick or untick one item")
            .WithDescription("{ index, text, checked }: the item is found by its index and must still read `text`; 409 stale otherwise.");
    }

    private static string Uid(ClaimsPrincipal user) => user.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static IResult View(Papyra.Api.Models.Note note, HttpContext http)
    {
        http.Response.Headers.ETag = LiveAgentEdits.ETag(note.Body);
        return Results.Ok(new { noteId = note.Id, title = note.Title, items = Checklist.Parse(note.Body) });
    }

    private static async Task<IResult> Read(
        string id, ClaimsPrincipal user, HttpContext http, VaultState state, MarkdownStorageService storage,
        ICollabEngine collab, CancellationToken ct)
    {
        if (!PathGuard.IsValidNoteId(id)) return Results.NotFound();
        var uid = Uid(user);
        if (state.PathFor(uid, id) is not { } path) return Results.NotFound();
        if (await collab.IsRoomActiveAsync(uid, id, ct)) await collab.FlushAsync(uid, id, ct);
        var note = await storage.ReadAsync(path, ct);
        if (note is null || note.Trashed || note.Kind != "todo") return Results.NotFound();
        if (note.Secure) return Results.Json(new { error = "Unlock required.", code = "locked" }, statusCode: StatusCodes.Status401Unauthorized);
        return View(note, http);
    }

    private static async Task<IResult> Check(
        string id, ChecklistTick body, ClaimsPrincipal user, HttpContext http, VaultState state,
        MarkdownStorageService storage, NoteBodyWriter writer, ICollabEngine collab, AppDbContext db,
        EmbeddingService embeddings, CancellationToken ct)
    {
        if (!PathGuard.IsValidNoteId(id)) return Results.NotFound();
        if (user.Identity?.AuthenticationType == "ApiKey")
            return Results.Json(new { error = "Ticking an embedded to-do is the app's.", code = "key_forbidden" }, statusCode: StatusCodes.Status403Forbidden);
        if (string.IsNullOrWhiteSpace(body.Text) || body.Index < 0)
            return Results.UnprocessableEntity(new { error = "Say which item.", code = "invalid" });

        var uid = Uid(user);
        // A save landing between our read and our write sends us round again.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var live = await collab.IsRoomActiveAsync(uid, id, ct);
            if (live) await collab.FlushAsync(uid, id, ct);
            var path = state.PathFor(uid, id);
            var current = path is null ? null : await storage.ReadAsync(path, ct);
            if (current is null || current.Trashed || current.Kind != "todo") return Results.NotFound();
            if (current.Secure)
                return Results.Json(new { error = "Unlock required.", code = "locked" }, statusCode: StatusCodes.Status401Unauthorized);

            var (status, patched) = Checklist.Set(current.Body, body.Index, body.Text, body.Checked);
            if (status == Checklist.TickStatus.Stale)
            {
                http.Response.Headers.ETag = LiveAgentEdits.ETag(current.Body);
                return Results.Json(new
                {
                    error = "That list changed since you opened it.", code = "stale",
                    noteId = current.Id, title = current.Title, items = Checklist.Parse(current.Body),
                }, statusCode: StatusCodes.Status409Conflict);
            }
            if (status == Checklist.TickStatus.Unchanged) return View(current, http);
            var baseHash = CollabHash.Of(current.Body);

            if (live)
            {
                var outcome = await collab.AgentEditAsync(uid, id, baseHash, patched, await LiveAgentEdits.AgentAsync(user, db, ct), ct);
                switch (outcome?.Kind)
                {
                    case AgentEditOutcome.Applied:
                        return state.PathFor(uid, id) is { } livePath && state.TryGet(uid, livePath, out var saved) && saved is not null
                            ? View(saved, http)
                            : Results.NotFound();
                    case AgentEditOutcome.Stale:
                        continue;
                    case AgentEditOutcome.Gone:
                        return Results.NotFound();
                    case AgentEditOutcome.NotLive:
                        break;
                    default:
                        return Results.Json(new { error = "Live editing is unavailable right now.", code = "collab_unavailable" },
                            statusCode: StatusCodes.Status503ServiceUnavailable);
                }
            }

            // The tick is worked out against the body under the note's write lock, not the one
            // read above: ticks that arrive together queue up and each lands on the last one's result.
            var seen = Checklist.TickStatus.Changed;
            var (written, refusal) = await writer.ChangeAsync(uid, id, note =>
            {
                if (note.Trashed || note.Kind != "todo") return NoteEdit.Refuse(Results.NotFound());
                if (note.Secure)
                    return NoteEdit.Refuse(Results.Json(new { error = "Unlock required.", code = "locked" }, statusCode: StatusCodes.Status401Unauthorized));
                var (now, next) = Checklist.Set(note.Body, body.Index, body.Text, body.Checked);
                seen = now;
                return now == Checklist.TickStatus.Changed ? new NoteEdit(next) : NoteEdit.Keep;
            }, LiveRoomPolicy.Refuse, ct);
            // A room opened (409 collab_active): start over, through it.
            if (refusal is IStatusCodeHttpResult { StatusCode: 409 or 412 }) continue;
            if (refusal is not null) return refusal;
            if (written is null) return Results.NotFound();
            if (seen == Checklist.TickStatus.Stale)
            {
                http.Response.Headers.ETag = LiveAgentEdits.ETag(written.Body);
                return Results.Json(new
                {
                    error = "That list changed since you opened it.", code = "stale",
                    noteId = written.Id, title = written.Title, items = Checklist.Parse(written.Body),
                }, statusCode: StatusCodes.Status409Conflict);
            }
            if (seen == Checklist.TickStatus.Changed) embeddings.Enqueue(uid, id, written.Body);
            return View(written, http);
        }
        return Results.Json(new { error = "The list kept changing. Try again.", code = "busy" }, statusCode: StatusCodes.Status409Conflict);
    }
}
