using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Live state of a user's import, pushed over SignalR as "ImportProgress" and served
// by GET /api/import/status — so a Settings page that remounts mid-import picks the
// bar back up instead of offering to start a second import. Only the worker mutates
// it; readers see whole ints, which is all a progress bar needs.
public sealed class ImportStatus
{
    public string JobId { get; init; } = string.Empty;
    public string Provider { get; init; } = string.Empty;
    public int Processed { get; set; }
    public int Total { get; set; }
    public bool Done { get; set; }
    public string? Error { get; set; }
    // Outcome tally: brand-new notes, existing notes overwritten with the import's
    // version, notes already identical (left alone — never duplicated), and entries
    // skipped (trashed in the source, or unreadable).
    public int Imported { get; set; }
    public int Updated { get; set; }
    public int Unchanged { get; set; }
    public int Skipped { get; set; }
}

// One queued import. The upload is parked on disk (ZipPath) and the worker owns
// its lifetime — it deletes the temp file when the job finishes (or fails).
public sealed record ImportJob(string JobId, string UserId, string Provider, string ZipPath, ImportStatus Status);

// Background import queue. The endpoint enqueues an uploaded archive and returns a
// job id immediately; this hosted service drains the channel one job at a time so a
// large import never blocks a request thread. One import per user at a time.
//
// Every imported note is stamped with a `papyraImport` frontmatter key naming where
// it came from (a Keep note's creation time, an Obsidian note's id or vault path).
// Importing the same archive again finds each note by that key: an identical note is
// left alone, a changed one is overwritten in place with everything the import
// carries (content, colour, pin/archive, labels, last-modified) — never duplicated.
// Notes imported before the key existed are matched once by title + body.
//
// Writes go through the same atomic engine as the live editor — Write-Ring logged so
// the watcher ignores the echo — then mirrored into VaultState + Lucene and broadcast.
public sealed class ImportService : BackgroundService
{
    public const string ImportKeyField = "papyraImport";

    private readonly Channel<ImportJob> _queue = Channel.CreateUnbounded<ImportJob>();
    private readonly ConcurrentDictionary<string, ImportStatus> _status = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly WriteRing _writeRing;
    private readonly SnapshotService _snapshots;
    private readonly OrderStore _order;
    private readonly IHubContext<NotesHub> _hub;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly ILogger<ImportService> _logger;

    public ImportService(
        MarkdownStorageService storage,
        VaultState state,
        SearchIndexService search,
        WriteRing writeRing,
        SnapshotService snapshots,
        OrderStore order,
        IHubContext<NotesHub> hub,
        IConfiguration config,
        IHostEnvironment env,
        ILogger<ImportService> logger)
    {
        _storage = storage;
        _state = state;
        _search = search;
        _writeRing = writeRing;
        _snapshots = snapshots;
        _order = order;
        _hub = hub;
        _config = config;
        _env = env;
        _logger = logger;
    }

    // The user's running import, or the last finished one (its summary), or null.
    public ImportStatus? StatusFor(string userId) => _status.GetValueOrDefault(userId);

    // Park the upload as a queued job; the worker takes it from here. Returns null
    // while this user already has an import queued or running.
    public ImportStatus? Enqueue(string userId, string provider, string zipPath)
    {
        lock (_gate)
        {
            if (_status.TryGetValue(userId, out var current) && !current.Done) return null;
            var status = new ImportStatus { JobId = Guid.NewGuid().ToString("N"), Provider = provider };
            _status[userId] = status;
            _queue.Writer.TryWrite(new ImportJob(status.JobId, userId, provider, zipPath, status));
            return status;
        }
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
                job.Status.Error = ex.Message;
                job.Status.Done = true;
                await PushAsync(job, ct);
            }
            finally
            {
                job.Status.Done = true;
                if (File.Exists(job.ZipPath)) File.Delete(job.ZipPath);
            }
        }
    }

    // A note parsed out of the archive, before it's matched against the vault.
    private sealed record Incoming(
        Note Note,
        DateTime? Modified,
        DateTime? Created,
        double? OrderKey,
        List<ZipArchiveEntry> Media);

    // An on-disk note the import may land on.
    private sealed record Existing(string Path, Note Note);

    private async Task ProcessAsync(ImportJob job, CancellationToken ct)
    {
        var status = job.Status;
        var notesDir = PapyraPaths.UserNotesDir(_config, _env.ContentRootPath, job.UserId);
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, job.UserId);
        Directory.CreateDirectory(notesDir);
        Directory.CreateDirectory(mediaDir);

        using var zip = ZipFile.OpenRead(job.ZipPath);

        var keep = job.Provider == "keep";
        var vaultRoot = keep ? string.Empty : ObsidianVaultRoot(zip);
        var bookmarks = keep ? [] : ObsidianBookmarks(zip, vaultRoot);

        // Provider decides which entries become notes; total drives the progress bar.
        var noteEntries = zip.Entries
            .Where(e => keep
                ? e.Name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                : e.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                  && !IsHiddenPath(RelativePath(e.FullName, vaultRoot)))
            .ToList();
        status.Total = noteEntries.Count;
        await PushAsync(job, ct);

        var vault = await LoadVaultAsync(notesDir, ct);
        var order = _order.Read(job.UserId);
        var orderChanged = false;
        var byName = MediaLookup(zip);
        var clock = Stopwatch.StartNew();

        foreach (var entry in noteEntries)
        {
            ct.ThrowIfCancellationRequested();

            Incoming? incoming;
            try
            {
                incoming = keep
                    ? await ReadKeepNoteAsync(entry, byName, ct)
                    : await ReadObsidianNoteAsync(entry, vaultRoot, bookmarks, ct);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            {
                _logger.LogWarning(ex, "Import {JobId}: skipping unreadable entry {Entry}", job.JobId, entry.FullName);
                incoming = null;
            }

            if (incoming is null) status.Skipped++;
            else
            {
                var outcome = await LandAsync(job, incoming, vault, notesDir, mediaDir, ct);
                switch (outcome)
                {
                    case Outcome.Unchanged: status.Unchanged++; break;
                    case Outcome.Updated: status.Updated++; break;
                    default: status.Imported++; break;
                }

                if (outcome != Outcome.Unchanged)
                    orderChanged |= ApplyOrder(order, incoming);
            }

            status.Processed++;
            // Throttle the socket chatter on a big archive; the bar needn't be per-note.
            if (clock.ElapsedMilliseconds > 150)
            {
                await PushAsync(job, ct);
                clock.Restart();
            }
        }

        if (orderChanged) _order.Write(job.UserId, order);

        // Obsidian vaults ship attachments alongside the .md files — land any
        // non-markdown entry in the media dir so ![[filename]] links resolve.
        if (!keep)
            foreach (var entry in zip.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue; // directory entry
                if (entry.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
                if (IsHiddenPath(RelativePath(entry.FullName, vaultRoot))) continue;
                await CopyMediaAsync(entry, mediaDir, ct);
            }

        status.Done = true;
        await PushAsync(job, ct);
    }

    private enum Outcome { Created, Updated, Unchanged }

    // Match the incoming note against the vault and write it — new, overwritten in
    // place, or not at all when the vault already holds exactly this version.
    private async Task<Outcome> LandAsync(
        ImportJob job, Incoming incoming, VaultIndex vault, string notesDir, string mediaDir, CancellationToken ct)
    {
        var note = incoming.Note;
        var key = ImportKey(note)!;
        var match = vault.Find(note);

        if (match is not null && IsSameNote(match.Note, note, incoming.Modified))
        {
            vault.Claim(match, key);
            return Outcome.Unchanged;
        }

        foreach (var media in incoming.Media) await CopyMediaAsync(media, mediaDir, ct);

        string path;
        if (match is not null)
        {
            // Overwrite in place: the import's fields win, but Papyra-only state (a
            // lock, a trip to the Trash) belongs to this vault, not to the source.
            note.Id = match.Note.Id;
            note.Secure = match.Note.Secure;
            note.Trashed = match.Note.Trashed;
            note.TrashedAt = match.Note.TrashedAt;
            var extras = new Dictionary<string, object?>(match.Note.ExtraFrontmatter);
            foreach (var (k, v) in note.ExtraFrontmatter) extras[k] = v;
            note.ExtraFrontmatter = extras;
            path = match.Path;

            // Keep the version being replaced recoverable from History.
            var snapRoot = PapyraPaths.UserSnapshotsDir(_config, _env.ContentRootPath, job.UserId);
            await _snapshots.CaptureAsync(PathGuard.ResolveAndVerify(snapRoot, note.Id, _logger), path, ct, force: true);
        }
        else
        {
            // A source id (an Obsidian `id:`) is kept only while it's free here.
            if (string.IsNullOrWhiteSpace(note.Id) || vault.IdTaken(note.Id)) note.Id = Guid.NewGuid().ToString();
            path = PathGuard.ResolveAndVerify(notesDir, $"{note.Id}.md", _logger);
        }

        _writeRing.Mark(path); // our write — the watcher must ignore the echo
        await _storage.WriteAsync(path, note, ct, mergeExisting: false);

        // Last-modified is the file's mtime — stamp the source's, not "now". The
        // creation time goes first: where it can't be stored it lands on mtime.
        if (incoming.Created is { } created) TrySetCreationTime(path, created);
        note.Updated = incoming.Modified ?? DateTime.UtcNow;
        _writeRing.Mark(path);
        File.SetLastWriteTimeUtc(path, note.Updated);

        _state.Upsert(job.UserId, path, note);
        _search.IndexNote(job.UserId, note);
        await _hub.Clients.User(job.UserId).SendAsync(
            match is null ? "NoteCreated" : "NoteUpdated", NoteMetadata.From(note), ct);

        vault.Claim(match ?? new Existing(path, note), key, replacement: new Existing(path, note));
        return match is null ? Outcome.Created : Outcome.Updated;
    }

    // Keep has no manual order in Takeout, but its grid shows notes newest-created
    // first unless dragged — so place imported Keep notes by creation time. Obsidian
    // has no grid order to carry, so its notes fall back to recency (their mtime);
    // a stale drag position from an earlier import must not override that.
    private static bool ApplyOrder(Dictionary<string, OrderStore.Entry> order, Incoming incoming)
    {
        var id = incoming.Note.Id;
        if (incoming.OrderKey is { } key)
        {
            order[id] = new OrderStore.Entry(key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return true;
        }
        return order.Remove(id);
    }

    private async Task PushAsync(ImportJob job, CancellationToken ct)
    {
        try
        {
            await _hub.Clients.User(job.UserId).SendAsync("ImportProgress", job.Status, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Import {JobId}: progress push failed", job.JobId);
        }
    }

    // ── Vault index ─────────────────────────────────────────────────────────

    // Every note already on disk, keyed three ways: by import key (a previous import
    // of the same source note), by id (a Papyra export coming back), and by title +
    // body for notes imported before the key existed.
    private sealed class VaultIndex
    {
        private readonly Dictionary<string, Existing> _byKey = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Existing> _byId = new(StringComparer.Ordinal);
        private readonly Dictionary<string, List<Existing>> _byContent = new(StringComparer.Ordinal);

        public void Add(Existing e)
        {
            if (!string.IsNullOrEmpty(e.Note.Id)) _byId[e.Note.Id] = e;
            if (ImportKey(e.Note) is { } key) _byKey[key] = e;
            else
            {
                var content = ContentKey(e.Note);
                if (!_byContent.TryGetValue(content, out var list)) _byContent[content] = list = [];
                list.Add(e);
            }
        }

        public bool IdTaken(string id) => _byId.ContainsKey(id);

        public Existing? Find(Note incoming)
        {
            if (ImportKey(incoming) is { } key && _byKey.TryGetValue(key, out var byKey)) return byKey;

            // A note that came from this vault (exported, then re-imported) carries
            // its Papyra id — unless that id now belongs to a different import.
            if (!string.IsNullOrEmpty(incoming.Id)
                && _byId.TryGetValue(incoming.Id, out var byId)
                && ImportKey(byId.Note) is null)
                return byId;

            return _byContent.TryGetValue(ContentKey(incoming), out var legacy) && legacy.Count > 0
                ? legacy[0]
                : null;
        }

        // The existing note now answers to `key`; it can't be claimed again as a
        // legacy match by a second, identical note in the same archive.
        public void Claim(Existing existing, string key, Existing? replacement = null)
        {
            foreach (var list in _byContent.Values) list.Remove(existing);
            var current = replacement ?? existing;
            _byKey[key] = current;
            _byId[current.Note.Id] = current;
        }
    }

    private async Task<VaultIndex> LoadVaultAsync(string notesDir, CancellationToken ct)
    {
        var index = new VaultIndex();
        foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
        {
            try
            {
                if (await _storage.ReadAsync(path, ct) is { } note) index.Add(new Existing(path, note));
            }
            catch (IOException ex)
            {
                _logger.LogWarning(ex, "Import: could not read {Path}; it won't be matched", path);
            }
        }
        return index;
    }

    private static string? ImportKey(Note note) =>
        note.ExtraFrontmatter.TryGetValue(ImportKeyField, out var v) && v?.ToString() is { Length: > 0 } s ? s : null;

    private static string ContentKey(Note note) => $"{note.Title.Trim()}\u0000{NormalizeBody(note.Body)}";

    private static string NormalizeBody(string body) => body.Replace("\r\n", "\n").Trim();

    // ── Comparison ──────────────────────────────────────────────────────────

    // True when the vault's note already says exactly what the import says: same
    // title, body, labels, colour, pin/archive/kind, every frontmatter key the
    // import carries, and — when the source knows it — the same last-modified time
    // (to the second; zip and filesystem clocks round differently below that).
    public static bool IsSameNote(Note existing, Note incoming, DateTime? modified)
    {
        if (!string.Equals(existing.Title.Trim(), incoming.Title.Trim(), StringComparison.Ordinal)) return false;
        if (NormalizeBody(existing.Body) != NormalizeBody(incoming.Body)) return false;
        if (!existing.Tags.ToHashSet(StringComparer.Ordinal).SetEquals(incoming.Tags)) return false;
        if (!string.Equals(existing.Color ?? string.Empty, incoming.Color ?? string.Empty, StringComparison.OrdinalIgnoreCase)) return false;
        if (existing.Pinned != incoming.Pinned || existing.Archived != incoming.Archived) return false;
        if (!string.Equals(existing.Kind, incoming.Kind, StringComparison.OrdinalIgnoreCase)) return false;

        foreach (var (k, v) in incoming.ExtraFrontmatter)
            if (!existing.ExtraFrontmatter.TryGetValue(k, out var have) || Canon(have) != Canon(v)) return false;

        return modified is not { } m || Math.Abs((existing.Updated - m).TotalSeconds) < 1.5;
    }

    // Type-blind rendering of a YAML value, so "true" read back from disk equals the
    // bool it was written from and a list equals the same list.
    private static string Canon(object? value) => value switch
    {
        null => "~",
        string s => s,
        IDictionary map => "{" + string.Join(",", map.Keys.Cast<object>()
            .Select(k => $"{k}:{Canon(map[k])}").Order(StringComparer.Ordinal)) + "}",
        IEnumerable list => "[" + string.Join(",", list.Cast<object?>().Select(Canon)) + "]",
        bool b => b ? "true" : "false",
        _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "~",
    };

    // ── Google Keep ─────────────────────────────────────────────────────────

    // Keep's twelve note colours, folded onto Papyra's seven-swatch palette
    // (lib/noteColors.ts) by hue. Keep's own hexes are saturated and clash with the
    // paper surface, so the nearest muted swatch wins over an exact copy.
    private static readonly Dictionary<string, string?> KeepColors = new(StringComparer.OrdinalIgnoreCase)
    {
        ["DEFAULT"] = null,
        ["RED"] = "#ecd9da",       // Rose
        ["PINK"] = "#ecd9da",      // Rose
        ["ORANGE"] = "#ecdcd0",    // Clay
        ["BROWN"] = "#ecdcd0",     // Clay
        ["YELLOW"] = "#ece3cf",    // Sand
        ["GRAY"] = "#ece3cf",      // Sand — the palette's nearest neutral
        ["GREEN"] = "#dde7d4",     // Moss
        ["TEAL"] = "#dfe9df",      // Sage
        ["BLUE"] = "#d8e3ea",      // Sky
        ["CERULEAN"] = "#d8e3ea",  // Sky
        ["DARK_BLUE"] = "#d8e3ea", // Sky
        ["PURPLE"] = "#e2dcec",    // Lilac
    };

    public static string? MapKeepColor(string? keepColor) =>
        keepColor is not null && KeepColors.TryGetValue(keepColor, out var hex) ? hex : null;

    // Google Keep Takeout: one JSON object per note. Maps every field Takeout
    // carries: title, text or checklist (→ a to-do), labels, colour, pin/archive,
    // edited + created times, web links, and image attachments (copied into media
    // and embedded). Trashed notes and non-note JSON are skipped (null).
    private static async Task<Incoming?> ReadKeepNoteAsync(
        ZipArchiveEntry entry, Dictionary<string, ZipArchiveEntry> media, CancellationToken ct)
    {
        var json = await ReadEntryTextAsync(entry, ct);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        // Other Takeout products ship JSON too; a Keep note always has one of these.
        if (!root.TryGetProperty("textContent", out _) && !root.TryGetProperty("listContent", out _)
            && !root.TryGetProperty("userEditedTimestampUsec", out _))
            return null;

        if (Bool(root, "isTrashed")) return null;

        var parts = new List<string>();
        // A Keep checklist is a to-do, not prose — carry that across so it lands on
        // the To Do page instead of the notes desk with checkboxes nobody sees.
        var isChecklist = root.TryGetProperty("listContent", out var list)
            && list.ValueKind == JsonValueKind.Array
            && list.GetArrayLength() > 0;
        if (isChecklist)
        {
            parts.Add(string.Join('\n', list.EnumerateArray().Select(item =>
                $"- [{(Bool(item, "isChecked") ? 'x' : ' ')}] {Str(item, "text")}")));
        }
        else if (Str(root, "textContent") is { Length: > 0 } text)
        {
            parts.Add(text);
        }

        // Link chips Keep shows under a note.
        if (root.TryGetProperty("annotations", out var notes) && notes.ValueKind == JsonValueKind.Array)
        {
            var links = notes.EnumerateArray()
                .Where(a => Str(a, "url") is { Length: > 0 })
                .Select(a => Str(a, "title") is { Length: > 0 } t ? $"[{t}]({Str(a, "url")})" : $"<{Str(a, "url")}>")
                .ToList();
            if (links.Count > 0) parts.Add(string.Join('\n', links.Select(l => $"- {l}")));
        }

        // Images/recordings sit next to the JSON; embed each one that's really there.
        var attached = new List<ZipArchiveEntry>();
        if (root.TryGetProperty("attachments", out var files) && files.ValueKind == JsonValueKind.Array)
            foreach (var file in files.EnumerateArray())
                if (Str(file, "filePath") is { Length: > 0 } name && FindMedia(media, name) is { } hit)
                    attached.Add(hit);
        if (attached.Count > 0) parts.Add(string.Join('\n', attached.Select(a => $"![[{a.Name}]]")));

        var tags = root.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array
            ? labels.EnumerateArray()
                .Select(l => Str(l, "name"))
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Distinct(StringComparer.Ordinal)
                .ToList()
            : [];

        var edited = Usec(root, "userEditedTimestampUsec");
        var created = Usec(root, "createdTimestampUsec");
        var createdUsec = root.TryGetProperty("createdTimestampUsec", out var cu) ? cu.ToString() : null;

        var note = new Note
        {
            Title = Str(root, "title").Trim(),
            Tags = tags,
            Color = MapKeepColor(Str(root, "color")),
            Pinned = Bool(root, "isPinned"),
            Archived = Bool(root, "isArchived"),
            Kind = isChecklist ? "todo" : "note",
            Body = string.Join("\n\n", parts),
        };
        // Takeout has no note id; the creation stamp is stable across exports.
        note.ExtraFrontmatter[ImportKeyField] = createdUsec is { Length: > 0 }
            ? $"keep:{createdUsec}"
            : $"keep:{entry.FullName}";

        var orderAt = created ?? edited;
        return new Incoming(
            note,
            edited,
            created,
            orderAt is { } o ? new DateTimeOffset(o).ToUnixTimeMilliseconds() : null,
            attached);
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? string.Empty : string.Empty;

    private static bool Bool(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    // Keep stamps are microseconds since the epoch, as a number or a string.
    private static DateTime? Usec(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return null;
        long usec;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) usec = n;
        else if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var s)) usec = s;
        else return null;
        if (usec <= 0) return null;
        return DateTime.UnixEpoch.AddTicks(usec * 10);
    }

    // Attachments by bare filename; Takeout sometimes names an image .jpg in the
    // JSON but ships it as .jpeg, so fall back to the stem.
    private static Dictionary<string, ZipArchiveEntry> MediaLookup(ZipArchive zip)
    {
        var map = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries)
        {
            if (string.IsNullOrEmpty(e.Name)) continue;
            var ext = Path.GetExtension(e.Name);
            if (ext.Equals(".json", StringComparison.OrdinalIgnoreCase) || ext.Equals(".html", StringComparison.OrdinalIgnoreCase)) continue;
            map.TryAdd(e.Name, e);
            map.TryAdd("stem:" + Path.GetFileNameWithoutExtension(e.Name), e);
        }
        return map;
    }

    private static ZipArchiveEntry? FindMedia(Dictionary<string, ZipArchiveEntry> media, string name)
    {
        var bare = Path.GetFileName(name.Replace('\\', '/'));
        return media.GetValueOrDefault(bare) ?? media.GetValueOrDefault("stem:" + Path.GetFileNameWithoutExtension(bare));
    }

    // ── Obsidian ────────────────────────────────────────────────────────────

    // An Obsidian note is already markdown; reuse the zero-trust parser — which
    // carries foreign frontmatter on the Note (ExtraFrontmatter) so the write keeps
    // it. The title is the filename (as Obsidian shows it) unless the frontmatter
    // names one; last-modified is the file's mtime in the zip; a bookmarked (or
    // legacy-starred) note comes in pinned.
    private async Task<Incoming?> ReadObsidianNoteAsync(
        ZipArchiveEntry entry, string vaultRoot, HashSet<string> bookmarks, CancellationToken ct)
    {
        var rel = RelativePath(entry.FullName, vaultRoot);
        var content = await ReadEntryTextAsync(entry, ct);
        var note = _storage.Deserialize(content);

        if (string.IsNullOrWhiteSpace(note.Title))
            note.Title = Path.GetFileNameWithoutExtension(entry.Name);
        // Obsidian allows `#tag` in the frontmatter list; Papyra stores bare names.
        note.Tags = note.Tags
            .Select(t => t.Trim().TrimStart('#'))
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (bookmarks.Contains(rel)) note.Pinned = true;

        // An `id:` survives renames; otherwise the note is its path in the vault.
        note.ExtraFrontmatter[ImportKeyField] = string.IsNullOrWhiteSpace(note.Id)
            ? $"obsidian:{rel}"
            : $"obsidian:id:{note.Id}";

        // A date the note states about itself (Obsidian templates and plugins write
        // these) is exact; the zip's stamp is zone-less wall-clock time, so it's the
        // fallback. Zip stamps below 1981 are "unknown" placeholders, not edits.
        var modified = FrontmatterDate(note, "modified", "updated", "date modified", "last_modified", "lastmod")
            ?? (entry.LastWriteTime.Year > 1980 ? entry.LastWriteTime.UtcDateTime : null);
        var created = FrontmatterDate(note, "created", "date created", "created_at");
        return new Incoming(note, modified, created, null, []);
    }

    private static DateTime? FrontmatterDate(Note note, params string[] keys)
    {
        foreach (var key in keys)
        {
            var hit = note.ExtraFrontmatter.FirstOrDefault(kv => string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase));
            if (hit.Value?.ToString() is { Length: > 0 } s
                && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal, out var at))
                return at.UtcDateTime;
        }
        return null;
    }

    // The folder holding `.obsidian/` is the vault root; failing that, a single
    // wrapping folder (how most zip tools pack a directory). Paths are relative to it.
    private static string ObsidianVaultRoot(ZipArchive zip)
    {
        var names = zip.Entries.Select(e => e.FullName.Replace('\\', '/')).ToList();
        foreach (var n in names)
        {
            if (n.StartsWith(".obsidian/", StringComparison.Ordinal)) return string.Empty;
            var i = n.IndexOf("/.obsidian/", StringComparison.Ordinal);
            if (i >= 0) return n[..(i + 1)];
        }

        var tops = names
            .Where(n => !n.StartsWith("__MACOSX/", StringComparison.Ordinal))
            .Select(n => n.Contains('/') ? n[..(n.IndexOf('/') + 1)] : string.Empty)
            .Distinct()
            .ToList();
        return tops.Count == 1 ? tops[0] : string.Empty;
    }

    private static string RelativePath(string fullName, string root)
    {
        var n = fullName.Replace('\\', '/');
        return root.Length > 0 && n.StartsWith(root, StringComparison.Ordinal) ? n[root.Length..] : n;
    }

    // Obsidian's own config, its trash, git metadata and macOS zip litter aren't notes.
    private static bool IsHiddenPath(string rel) =>
        rel.Split('/').Any(seg => seg.StartsWith('.') || seg == "__MACOSX");

    // Bookmarked files (bookmarks.json, groups included) plus the older starred.json.
    private static HashSet<string> ObsidianBookmarks(ZipArchive zip, string vaultRoot)
    {
        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in new[] { "bookmarks.json", "starred.json" })
        {
            var entry = zip.GetEntry($"{vaultRoot}.obsidian/{file}");
            if (entry is null) continue;
            try
            {
                using var stream = entry.Open();
                using var doc = JsonDocument.Parse(stream);
                if (doc.RootElement.TryGetProperty("items", out var items)) Walk(items);
            }
            catch (JsonException) { /* a broken bookmarks file just means no pins */ }
        }
        return paths;

        void Walk(JsonElement items)
        {
            if (items.ValueKind != JsonValueKind.Array) return;
            foreach (var item in items.EnumerateArray())
            {
                if (Str(item, "type") == "file" && Str(item, "path") is { Length: > 0 } p) paths.Add(p);
                if (item.TryGetProperty("items", out var nested)) Walk(nested);
            }
        }
    }

    // ── Files ───────────────────────────────────────────────────────────────

    // Land an attachment in the media dir under its bare filename, path-jailed. The
    // same file from a repeat import is left alone. Media isn't watched, so no ring.
    private async Task CopyMediaAsync(ZipArchiveEntry entry, string mediaDir, CancellationToken ct)
    {
        var dest = PathGuard.ResolveAndVerify(mediaDir, Path.GetFileName(entry.Name), _logger);
        if (File.Exists(dest) && new FileInfo(dest).Length == entry.Length) return;
        await using var src = entry.Open();
        await using var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None);
        await src.CopyToAsync(fs, ct);
    }

    // Creation time is best-effort: not every filesystem keeps a settable one.
    // Linux has none — .NET's SetCreationTime there rewrites the mtime instead,
    // which would replace the note's last-modified with its creation date.
    private void TrySetCreationTime(string path, DateTime created)
    {
        if (!OperatingSystem.IsWindows() && !OperatingSystem.IsMacOS()) return;
        try
        {
            _writeRing.Mark(path);
            File.SetCreationTimeUtc(path, created);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            _logger.LogDebug(ex, "Could not set creation time on {Path}", path);
        }
    }

    private static async Task<string> ReadEntryTextAsync(ZipArchiveEntry entry, CancellationToken ct)
    {
        await using var stream = entry.Open();
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync(ct);
    }
}
