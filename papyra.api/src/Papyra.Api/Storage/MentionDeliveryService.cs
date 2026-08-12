using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Phase 15.2. `@username` in a saved note delivers a reference to the mentioned
// block into that user's Inbox.md, plus a BlockGrant authorising them to resolve
// it. Detection is server-side on purpose: the notes PUT is also reachable from
// API keys, sharee edits and the public edit-link route, none of which run the
// editor, so a client-side hook would be trivially bypassable.
//
// This is the ONLY code path in Papyra that writes into a vault the caller does
// not own. It touches exactly one file — the recipient's Inbox.md — and gets
// there through PathGuard against the *recipient's* base dir.
public sealed partial class MentionDeliveryService : BackgroundService
{
    // `@name` as a standalone token: not inside a word, not an email address.
    [GeneratedRegex(@"(?<=^|[\s(\[])@(?<name>[A-Za-z0-9][A-Za-z0-9._-]{0,63})\b")]
    private static partial Regex MentionToken();

    /// <summary>Distinct usernames mentioned in a body, lower-cased, first-seen order.</summary>
    public static IReadOnlyList<string> Mentions(string? body)
    {
        var seen = new List<string>();
        if (string.IsNullOrEmpty(body)) return seen;
        foreach (Match m in MentionToken().Matches(body))
        {
            var name = m.Groups["name"].Value.TrimEnd('.', '_', '-');
            if (name.Length == 0) continue;
            if (!seen.Contains(name, StringComparer.OrdinalIgnoreCase)) seen.Add(name);
        }
        return seen;
    }

    /// <summary>
    /// The anchor of the block a mention sits in, so the recipient receives that
    /// block and not the whole note. Null when the mentioning block carries no
    /// anchor (a list item, a table row, a code line — none are stampable).
    /// </summary>
    public static string? BlockForMention(string? body, string username)
    {
        if (string.IsNullOrEmpty(body)) return null;
        var lines = body.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (!MentionToken().Matches(lines[i])
                .Any(m => string.Equals(m.Groups["name"].Value, username, StringComparison.OrdinalIgnoreCase)))
                continue;
            // Anchors sit on the line itself (the editor stamps per block).
            var anchor = BlockResolver.Anchors(lines[i]).FirstOrDefault();
            if (anchor.BlockId is { Length: > 0 }) return anchor.BlockId;
        }
        return null;
    }

    /// <summary>
    /// Deliveries one sender may make to one recipient per hour. Anyone on a
    /// shared instance can append to anyone's inbox — that is what a mention is —
    /// so the volume has to be capped or a single note saved in a loop becomes a
    /// spam cannon. Scoped per sender/recipient pair so throttling one abuser
    /// never costs a third party their pings.
    /// </summary>
    public const int MaxDeliveriesPerSenderPerHour = 20;

    /// <summary>
    /// Entries kept in an Inbox.md before the oldest are dropped. The file is a
    /// human-readable mirror, not the record of truth — the BlockGrant rows are,
    /// and `/api/inbox` reads those — so trimming bounds unbounded disk growth
    /// without losing an entry from the actual inbox.
    /// </summary>
    public const int MaxInboxEntries = 500;

    /// <summary>Keep only the newest <paramref name="max"/> blank-line-separated entries.</summary>
    public static string TrimToNewestEntries(string body, int max)
    {
        if (string.IsNullOrEmpty(body) || max <= 0) return body;
        var entries = body.Replace("\r\n", "\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries);
        if (entries.Length <= max) return body;
        return string.Join("\n\n", entries[^max..]);
    }

    private readonly record struct Job(int OwnerId, string OwnerUsername, string NoteId, string Body, string? PriorBody);

    private readonly Channel<Job> _queue = Channel.CreateUnbounded<Job>();
    private readonly IServiceScopeFactory _scopes;
    private readonly MarkdownStorageService _storage;
    private readonly VaultObserverOptions _vault;
    private readonly WriteRing _writeRing;
    private readonly VaultState _state;
    private readonly IHubContext<NotesHub> _hub;
    private readonly ILogger<MentionDeliveryService> _logger;

    public MentionDeliveryService(
        IServiceScopeFactory scopes,
        MarkdownStorageService storage,
        VaultObserverOptions vault,
        WriteRing writeRing,
        VaultState state,
        IHubContext<NotesHub> hub,
        ILogger<MentionDeliveryService> logger)
    {
        _scopes = scopes;
        _storage = storage;
        _vault = vault;
        _writeRing = writeRing;
        _state = state;
        _hub = hub;
        _logger = logger;
    }

    /// <summary>
    /// Queue a saved note for mention delivery. `priorBody` is the revision being
    /// replaced: only mentions that are NEW in this save are delivered, so
    /// re-saving a note never re-pings everyone named in it.
    /// </summary>
    public void Enqueue(string ownerId, string ownerUsername, string noteId, string body, string? priorBody)
    {
        if (!int.TryParse(ownerId, out var uid)) return;
        // Nothing in a secure note leaves it — its body is withheld from every
        // other read path, and a mention would smuggle a block out.
        if (string.IsNullOrEmpty(body)) return;
        _queue.Writer.TryWrite(new Job(uid, ownerUsername, noteId, body, priorBody));
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(ct))
        {
            try { await DeliverAsync(job, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Mention delivery failed for note {NoteId}", job.NoteId); }
        }
    }

    private async Task DeliverAsync(Job job, CancellationToken ct)
    {
        var added = Mentions(job.Body)
            .Except(Mentions(job.PriorBody), StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (added.Length == 0) return;

        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        foreach (var username in added)
        {
            var recipient = await db.Users.FirstOrDefaultAsync(
                u => u.Username.ToLower() == username.ToLower(), ct);
            // Unknown user: drop silently rather than answering "no such account"
            // — a note body is not an account-existence oracle.
            if (recipient is null || recipient.Id == job.OwnerId) continue;

            var blockId = BlockForMention(job.Body, username);
            // No anchor on the mentioning block (list item, table cell, code line):
            // there is nothing to reference, and writing the whole note into
            // someone's inbox is exactly what this feature must not do.
            if (blockId is null) continue;

            var already = await db.BlockGrants.AnyAsync(
                g => g.SourceOwnerId == job.OwnerId
                     && g.SourceNoteId == job.NoteId
                     && g.BlockId == blockId
                     && g.GranteeUserId == recipient.Id, ct);
            if (already) continue;

            // Volume cap for this sender→recipient pair. The grant rows are their
            // own ledger, so this needs no extra state and survives a restart.
            var since = DateTime.UtcNow.AddHours(-1);
            var recent = await db.BlockGrants.CountAsync(
                g => g.SourceOwnerId == job.OwnerId
                     && g.GranteeUserId == recipient.Id
                     && g.CreatedUtc >= since, ct);
            if (recent >= MaxDeliveriesPerSenderPerHour)
            {
                _logger.LogWarning(
                    "Mention delivery throttled: user {Sender} hit the hourly cap for recipient {Recipient}",
                    job.OwnerId, recipient.Id);
                continue;
            }

            db.BlockGrants.Add(new BlockGrant
            {
                SourceOwnerId = job.OwnerId,
                SourceNoteId = job.NoteId,
                BlockId = blockId,
                GranteeUserId = recipient.Id,
                SourceUsername = job.OwnerUsername,
                CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync(ct);

            await AppendToInboxAsync(recipient.Id.ToString(), job, blockId, ct);
            await _hub.Clients.All.SendAsync("InboxDelivered", new { recipientId = recipient.Id }, ct);
        }
    }

    // Append one reference line to the recipient's Inbox.md, creating it if
    // absent. Everything about this method assumes it is writing into a foreign
    // vault: the path is resolved against the recipient's own notes dir and
    // verified by PathGuard, and no other file there is ever touched.
    private async Task AppendToInboxAsync(string recipientId, Job job, string blockId, CancellationToken ct)
    {
        var notesDir = _vault.UserNotesDir(recipientId);
        Directory.CreateDirectory(notesDir);
        var path = PathGuard.ResolveAndVerify(notesDir, $"{InboxNoteId}.md");

        var existing = File.Exists(path) ? await _storage.ReadAsync(path, ct) : null;
        var entry = $"![[{job.NoteId}#^{blockId}]]\n— @{job.OwnerUsername} · {DateTime.UtcNow:yyyy-MM-dd HH:mm} UTC";

        var note = existing ?? new Note
        {
            Id = InboxNoteId,
            Title = "Inbox",
            Kind = InboxKind,
            Body = string.Empty,
        };
        note.Kind = InboxKind;           // keep it off the notes desk even if edited
        note.Id = InboxNoteId;
        note.Body = string.IsNullOrWhiteSpace(note.Body) ? entry : $"{note.Body.TrimEnd()}\n\n{entry}";
        note.Body = TrimToNewestEntries(note.Body, MaxInboxEntries);
        note.Updated = DateTime.UtcNow;

        _writeRing.Mark(path);           // our write — the watcher must ignore the echo
        await _storage.WriteAsync(path, note, ct);
        _state.Upsert(recipientId, path, note);
    }

    /// <summary>Fixed note id for a tenant's inbox; one per user.</summary>
    public const string InboxNoteId = "Inbox";
    /// <summary>`kind` that keeps the inbox out of the notes desk and the To Do page.</summary>
    public const string InboxKind = "inbox";
}
