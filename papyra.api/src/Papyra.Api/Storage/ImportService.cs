using System.IO.Compression;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// One queued import. The upload is parked on disk (ZipPath) and the worker owns
// its lifetime — it deletes the temp file when the job finishes (or fails).
public sealed record ImportJob(string JobId, string UserId, string Provider, string ZipPath);

// Background import queue. The endpoint enqueues an uploaded archive and returns a
// job id immediately; this hosted service drains the channel one job at a time so a
// large import never blocks a request thread. Progress (and the final tally) is
// pushed over SignalR as "ImportProgress" {jobId, processed, total, done, error}.
// Imported notes are written through the same atomic engine as the live editor —
// Write-Ring logged so the watcher ignores the echo — then mirrored into VaultState
// + Lucene and broadcast as NoteCreated, exactly like the conflict "keep both" path.
public sealed class ImportService : BackgroundService
{
    private readonly Channel<ImportJob> _queue = Channel.CreateUnbounded<ImportJob>();
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly WriteRing _writeRing;
    private readonly IHubContext<NotesHub> _hub;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly ILogger<ImportService> _logger;

    public ImportService(
        MarkdownStorageService storage,
        VaultState state,
        SearchIndexService search,
        WriteRing writeRing,
        IHubContext<NotesHub> hub,
        IConfiguration config,
        IHostEnvironment env,
        ILogger<ImportService> logger)
    {
        _storage = storage;
        _state = state;
        _search = search;
        _writeRing = writeRing;
        _hub = hub;
        _config = config;
        _env = env;
        _logger = logger;
    }

    // Park the upload as a queued job; the worker takes it from here.
    public string Enqueue(string userId, string provider, string zipPath)
    {
        var jobId = Guid.NewGuid().ToString("N");
        _queue.Writer.TryWrite(new ImportJob(jobId, userId, provider, zipPath));
        return jobId;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(ct))
        {
            try
            {
                await ProcessAsync(job, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Import job {JobId} ({Provider}) failed", job.JobId, job.Provider);
                await _hub.Clients.All.SendAsync(
                    "ImportProgress",
                    new { jobId = job.JobId, done = true, error = ex.Message },
                    ct);
            }
            finally
            {
                if (File.Exists(job.ZipPath)) File.Delete(job.ZipPath);
            }
        }
    }

    private async Task ProcessAsync(ImportJob job, CancellationToken ct)
    {
        var notesDir = PapyraPaths.UserNotesDir(_config, _env.ContentRootPath, job.UserId);
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, job.UserId);
        Directory.CreateDirectory(notesDir);
        Directory.CreateDirectory(mediaDir);

        using var zip = ZipFile.OpenRead(job.ZipPath);

        // Provider decides which entries become notes; total drives the progress bar.
        var ext = job.Provider == "keep" ? ".json" : ".md";
        var noteEntries = zip.Entries
            .Where(e => e.Name.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
            .ToList();
        var total = noteEntries.Count;
        var processed = 0;
        var imported = 0;

        foreach (var entry in noteEntries)
        {
            ct.ThrowIfCancellationRequested();

            var note = job.Provider == "keep"
                ? await ReadKeepNoteAsync(entry, ct)
                : await ReadObsidianNoteAsync(entry, ct);

            if (note is not null)
            {
                var path = PathGuard.ResolveAndVerify(notesDir, $"{note.Id}.md", _logger);
                _writeRing.Mark(path); // our write — the watcher must ignore the echo
                await _storage.WriteAsync(path, note, ct);
                _state.Upsert(job.UserId, path, note);
                _search.IndexNote(job.UserId, note);
                await _hub.Clients.All.SendAsync("NoteCreated", NoteMetadata.From(note), ct);
                imported++;
            }

            processed++;
            await _hub.Clients.All.SendAsync(
                "ImportProgress",
                new { jobId = job.JobId, processed, total, done = false },
                ct);
        }

        // Obsidian vaults ship attachments alongside the .md files — land any
        // non-markdown entry in the media dir so ![[filename]] links resolve.
        if (job.Provider == "obsidian")
            await ImportAttachmentsAsync(zip, mediaDir, ct);

        await _hub.Clients.All.SendAsync(
            "ImportProgress",
            new { jobId = job.JobId, processed, total, done = true, imported },
            ct);
    }

    // An Obsidian note is already markdown; reuse the zero-trust parser — which
    // carries foreign frontmatter on the Note (ExtraFrontmatter) so the fresh write
    // preserves it — and only mint an id/title where the file lacks one.
    private async Task<Note?> ReadObsidianNoteAsync(ZipArchiveEntry entry, CancellationToken ct)
    {
        var content = await ReadEntryTextAsync(entry, ct);
        var note = _storage.Deserialize(content);
        if (string.IsNullOrEmpty(note.Id)) note.Id = Guid.NewGuid().ToString();
        if (string.IsNullOrWhiteSpace(note.Title))
            note.Title = Path.GetFileNameWithoutExtension(entry.Name);
        return note;
    }

    // Google Keep Takeout: one JSON object per note. Map the fields we own; render a
    // checklist note's items as markdown task lines. Skip trashed entries.
    private async Task<Note?> ReadKeepNoteAsync(ZipArchiveEntry entry, CancellationToken ct)
    {
        var json = await ReadEntryTextAsync(entry, ct);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (root.TryGetProperty("isTrashed", out var trashed) && trashed.GetBoolean())
            return null;

        var title = root.TryGetProperty("title", out var t) ? t.GetString() ?? string.Empty : string.Empty;

        string body;
        if (root.TryGetProperty("listContent", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            body = string.Join('\n', list.EnumerateArray().Select(item =>
            {
                var text = item.TryGetProperty("text", out var x) ? x.GetString() ?? string.Empty : string.Empty;
                var done = item.TryGetProperty("isChecked", out var c) && c.GetBoolean();
                return $"- [{(done ? 'x' : ' ')}] {text}";
            }));
        }
        else
        {
            body = root.TryGetProperty("textContent", out var tc) ? tc.GetString() ?? string.Empty : string.Empty;
        }

        var tags = root.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array
            ? labels.EnumerateArray()
                .Select(l => l.TryGetProperty("name", out var n) ? n.GetString() : null)
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Select(n => n!)
                .ToList()
            : [];

        return new Note
        {
            Id = Guid.NewGuid().ToString(),
            Title = title,
            Tags = tags,
            Color = null, // Keep's named colors don't map to our palette tokens
            Pinned = root.TryGetProperty("isPinned", out var p) && p.GetBoolean(),
            Archived = root.TryGetProperty("isArchived", out var a) && a.GetBoolean(),
            Body = body,
        };
    }

    // Copy every non-markdown entry into the media dir under its bare filename,
    // path-jailed. Self-writes aren't watched (media dir has no watcher), so no ring.
    private async Task ImportAttachmentsAsync(ZipArchive zip, string mediaDir, CancellationToken ct)
    {
        foreach (var entry in zip.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue; // directory entry
            if (entry.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;

            var dest = PathGuard.ResolveAndVerify(mediaDir, Path.GetFileName(entry.Name), _logger);
            await using var src = entry.Open();
            await using var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None);
            await src.CopyToAsync(fs, ct);
        }
    }

    private static async Task<string> ReadEntryTextAsync(ZipArchiveEntry entry, CancellationToken ct)
    {
        await using var stream = entry.Open();
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync(ct);
    }
}
