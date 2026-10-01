using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Collab;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// What a change decided: the new body and/or title (null keeps each), or a
/// refusal to return.
/// </summary>
public readonly record struct NoteEdit(string? Body, IResult? Refusal = null, string? Title = null)
{
    public static NoteEdit Keep => new(null);
    public static NoteEdit Refuse(IResult result) => new(null, result);
}

/// <summary>What to do when the note is open in a live room.</summary>
public enum LiveRoomPolicy
{
    /// <summary>A person editing through the classic path: refuse (409 <c>collab_active</c>).</summary>
    Refuse,
    /// <summary>A background append (web archive card, transcript): write, then merge it into the room.</summary>
    Merge,
}

/// <summary>
/// The one way to change a note's body from anywhere but the owner's own editor
/// save: a sharee's edit, the web archiver's "Saved article" card, a
/// transcription. Each used to write the file its own way — some without the
/// note's write lock, without a snapshot, without telling an open editor, and
/// straight over a live room. Here, every change:
/// <list type="bullet">
///   <item>runs under the note's write lock, starting from the copy on disk;</item>
///   <item>snapshots the prior revision first (recoverable);</item>
///   <item>writes atomically, updates the cache and the search index;</item>
///   <item>merges into a live room (<see cref="LiveRoomPolicy.Merge"/>) exactly as a
///   change from outside the app would, or refuses (<see cref="LiveRoomPolicy.Refuse"/>);</item>
///   <item>tells the owner's open editors (<c>NoteUpdated</c>).</item>
/// </list>
/// </summary>
public sealed class NoteBodyWriter(
    VaultState state, MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    SnapshotService snapshots, IConfiguration config, IHostEnvironment env, IHubContext<NotesHub> hub,
    ICollabEngine collab, NoteWriteLocks writeLocks, VaultObserverOptions vault, ILoggerFactory lf)
{
    private readonly ILogger _logger = lf.CreateLogger<NoteBodyWriter>();

    /// <summary>
    /// Apply <paramref name="change"/> to the note's current body. Returns the
    /// written note (or the unchanged one when <paramref name="change"/> kept it),
    /// or a refusal: 404 for a missing note, the change's own, or 409 while live.
    /// </summary>
    public async Task<(Note? Note, IResult? Refusal)> ChangeAsync(
        string ownerUid, string noteId, Func<Note, NoteEdit> change, LiveRoomPolicy live, CancellationToken ct)
    {
        if (!PathGuard.IsValidNoteId(noteId)) return (null, Results.NotFound());
        var path = CollabEndpoints.OwnerNotePath(state, vault, lf, ownerUid, noteId);
        using var writeLock = await writeLocks.AcquireAsync(ownerUid, noteId, ct);
        var note = await storage.ReadAsync(path, ct);
        if (note is null) return (null, Results.NotFound());

        var edit = change(note);
        if (edit.Refusal is not null) return (null, edit.Refusal);
        var newBody = edit.Body is not null && edit.Body != note.Body ? edit.Body : null;
        var newTitle = edit.Title is not null && edit.Title != note.Title ? edit.Title : null;
        if (newBody is null && newTitle is null) return (note, null);

        // Only the body lives in the room; a title is front matter, written
        // around it like the owner's own metadata save.
        if (newBody is not null && live == LiveRoomPolicy.Refuse
            && await CollabEndpoints.BodyWriteGuardAsync(collab, ownerUid, noteId, note.Body, newBody, ct) is { } busy)
            return (null, busy);

        var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, ownerUid);
        var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, noteId, lf.CreateLogger("PathGuard"));
        await snapshots.CaptureAsync(noteSnapDir, path, ct);

        if (newBody is not null) note.Body = newBody;
        if (newTitle is not null)
        {
            note.Title = newTitle;
            // The file follows its title, as it does for the owner's own rename.
            path = NoteFileNamer.Move(ownerUid, path,
                NoteFileNamer.TargetPath(path, NoteFileNamer.DesiredBaseName(note), noteId),
                state, writeRing, lf.CreateLogger("NoteFileNamer"));
        }
        note.Updated = DateTime.UtcNow;
        writeRing.Mark(path);
        await storage.WriteAsync(path, note, ct);
        state.Upsert(ownerUid, path, note);
        search.IndexNote(ownerUid, note);

        if (newBody is not null && live == LiveRoomPolicy.Merge && !note.Secure && collab.Status == CollabStatus.Ok)
        {
            // Our own write is invisible to the file watcher (WriteRing), so hand
            // it to any live room ourselves — the room merges it block-wise and
            // its next hash-checked save builds on it.
            try { await collab.ExternalChangeAsync(ownerUid, noteId, note.Body, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Could not merge a background change into the live room for {NoteId}", noteId);
            }
        }

        await hub.Clients.User(ownerUid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
        return (note, null);
    }
}
