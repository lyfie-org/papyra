using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

/// <summary>
/// Keeps text pointing at renamed things. A note's title changing rewrites the
/// <c>[[Old title]]</c> links to it in its owner's other notes; a username
/// changing rewrites <c>@old</c> mentions in every vault and in comments.
/// Queued (a vault can be large) and written through <see cref="NoteBodyWriter"/>
/// with <see cref="LiveRoomPolicy.Merge"/>: each change is snapshotted first,
/// merges into a note someone has open live, and reaches open editors. Locked
/// notes are left as written — their bodies never change from outside the vault.
/// </summary>
public sealed class RenamePropagationService(
    IServiceProvider services, IServiceScopeFactory scopes, VaultState state, ILogger<RenamePropagationService> logger)
    : BackgroundService
{
    private abstract record Job;
    private sealed record LinkJob(string OwnerUid, string NoteId, string OldTitle, string NewTitle) : Job;
    private sealed record MentionJob(string OldName, string NewName) : Job;

    private readonly Channel<Job> _queue = Channel.CreateUnbounded<Job>(new UnboundedChannelOptions { SingleReader = true });

    /// <summary>Jobs queued or running — tests wait for this to reach zero.</summary>
    private int _pending;
    public bool Idle => Volatile.Read(ref _pending) == 0;

    /// <summary>A note was retitled: links to it by its old title follow.</summary>
    public void TitleChanged(string ownerUid, string noteId, string? oldTitle, string? newTitle)
    {
        var from = oldTitle?.Trim() ?? "";
        var to = newTitle?.Trim() ?? "";
        if (from.Length == 0 || from == to || !TextRenames.IsLinkableTitle(from) || !TextRenames.IsLinkableTitle(to)) return;
        Enqueue(new LinkJob(ownerUid, noteId, from, to));
    }

    /// <summary>A person's username changed: mentions of them follow.</summary>
    public void UsernameChanged(string oldName, string newName)
    {
        if (string.Equals(oldName, newName, StringComparison.Ordinal)) return;
        Enqueue(new MentionJob(oldName, newName));
    }

    private void Enqueue(Job job)
    {
        Interlocked.Increment(ref _pending);
        if (!_queue.Writer.TryWrite(job)) Interlocked.Decrement(ref _pending);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                switch (job)
                {
                    case LinkJob link: await RenameLinksAsync(link, stoppingToken); break;
                    case MentionJob mention: await RenameMentionsAsync(mention, stoppingToken); break;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Rename propagation failed for {Job}", job.GetType().Name);
            }
            finally
            {
                Interlocked.Decrement(ref _pending);
            }
        }
    }

    private NoteBodyWriter Writer() => ActivatorUtilities.CreateInstance<NoteBodyWriter>(services);

    private async Task RenameLinksAsync(LinkJob job, CancellationToken ct)
    {
        var notes = state.Snapshot(job.OwnerUid);
        // Links resolve by title: if another note still has the old title, the
        // links were (or now are) its links — leave them.
        if (notes.Any(n => n.Id != job.NoteId && !n.Trashed
                           && string.Equals(n.Title.Trim(), job.OldTitle, StringComparison.OrdinalIgnoreCase)))
            return;

        var writer = Writer();
        foreach (var note in notes.Where(n => !n.Secure && n.Body.Contains(job.OldTitle, StringComparison.OrdinalIgnoreCase)))
        {
            await writer.ChangeAsync(job.OwnerUid, note.Id, current =>
            {
                if (current.Secure) return NoteEdit.Keep;
                var body = TextRenames.RenameLinks(current.Body, job.OldTitle, job.NewTitle);
                return body == current.Body ? NoteEdit.Keep : new NoteEdit(body);
            }, LiveRoomPolicy.Merge, ct);
        }
        logger.LogInformation("Links to a retitled note followed");
    }

    private async Task RenameMentionsAsync(MentionJob job, CancellationToken ct)
    {
        var writer = Writer();
        var needle = "@" + job.OldName;
        foreach (var uid in state.Users)
        {
            foreach (var note in state.Snapshot(uid).Where(n => !n.Secure && n.Body.Contains(needle, StringComparison.OrdinalIgnoreCase)))
            {
                await writer.ChangeAsync(uid, note.Id, current =>
                {
                    if (current.Secure) return NoteEdit.Keep;
                    var body = TextRenames.RenameMentions(current.Body, job.OldName, job.NewName);
                    return body == current.Body ? NoteEdit.Keep : new NoteEdit(body);
                }, LiveRoomPolicy.Merge, ct);
            }
        }

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var comments = await db.NoteComments.Where(c => c.Body.ToLower().Contains(needle.ToLower())).ToListAsync(ct);
        foreach (var comment in comments)
            comment.Body = TextRenames.RenameMentions(comment.Body, job.OldName, job.NewName);
        await db.SaveChangesAsync(ct);
        logger.LogInformation("Mentions of a renamed account followed");
    }
}
