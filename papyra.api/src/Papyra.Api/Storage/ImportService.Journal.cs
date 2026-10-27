using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Bringing a journal in from somewhere else. Two shapes of archive:
//   dayone   a Day One JSON export (Journal.json + photos/ audios/ …)
//   journal  files named for their day — Obsidian daily notes, or any folder of
//            2024-03-02.md — anywhere in the zip
// Each day lands in the journal through the same write a person's own save uses, so
// the streak, search, history and locking all behave. A day that already has writing
// keeps it: what comes in is added beneath an "Imported from …" heading, and doing the
// same import again adds nothing (the text is already there). A locked or trashed day is
// never touched — it is counted as skipped.
public sealed partial class ImportService
{
    private sealed record ImportedDay(DateOnly Day, string Body, List<string> Tags, int? Mood);

    [GeneratedRegex(@"^(?<d>\d{4}-\d{2}-\d{2})(?!\d)")]
    private static partial Regex DatedName();

    // Day One writes a photo as ![](dayone-moment://ID), a recording as dayone-moment:/audio/ID.
    [GeneratedRegex(@"!\[[^\]]*\]\(dayone-moment:/{1,2}(?:(?:audio|video|pdfAttachment)/)?(?<id>[A-Za-z0-9\-]+)\)")]
    private static partial Regex DayOneMoment();

    // Day One backslash-escapes punctuation in plain prose ("Lovely day\.").
    [GeneratedRegex(@"\\([.\-!()+])")]
    private static partial Regex DayOneEscape();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    private static string Squash(string? s) => Spaces().Replace(s ?? string.Empty, " ").Trim();

    private async Task ImportJournalAsync(ImportJob job, ZipArchive zip, ImportBudget budget, string mediaDir, CancellationToken ct)
    {
        var status = job.Status;
        var journal = _journal ?? throw new InvalidOperationException("The journal isn't available here.");
        var (pinSet, timeZone) = await WhoAsync(job.UserId, ct);
        var days = job.Provider == "dayone"
            ? await ReadDayOneAsync(zip, mediaDir, budget, timeZone, ct)
            : await ReadDatedFilesAsync(zip, mediaDir, budget, ct);
        var source = job.Provider == "dayone" ? "Day One" : "a file";
        status.Total = days.Count;
        await PushAsync(job, ct);

        var clock = System.Diagnostics.Stopwatch.StartNew();
        foreach (var day in days)
        {
            ct.ThrowIfCancellationRequested();
            var existing = journal.Get(job.UserId, day.Day);
            if (existing is { Secure: true } or { Trashed: true }) status.Skipped++;
            else if (existing is not null && Squash(existing.Body).Contains(Squash(day.Body), StringComparison.Ordinal)) status.Unchanged++;
            else
            {
                var write = new JournalWrite
                {
                    Tags = existing is null ? day.Tags : existing.Tags.Union(day.Tags, StringComparer.Ordinal).ToList(),
                    Transform = current => string.IsNullOrWhiteSpace(current)
                        ? day.Body
                        : current.TrimEnd('\r', '\n') + $"\n\n## Imported from {source}\n\n" + day.Body,
                };
                // A mood already chosen for the day stays; an imported one fills an empty day.
                if (day.Mood is { } mood && (existing is null || JournalService.MoodOf(existing) is null))
                    write.Mood = JsonSerializer.SerializeToElement(mood);

                var result = await journal.WriteAsync(job.UserId, day.Day, write, JournalActor.Owner, timeZone, pinSet, false, ct);
                if (result.Status == JournalStatus.Ok && result.Note is not null)
                {
                    if (existing is null) status.Imported++; else status.Updated++;
                }
                else status.Skipped++;
            }

            status.Processed++;
            if (clock.ElapsedMilliseconds > 150) { await PushAsync(job, ct); clock.Restart(); }
        }

        _mediaJobs?.ScanUser(job.UserId);
        status.Done = true;
        await PushAsync(job, ct);
    }

    /// <summary>The person's time zone and whether a vault PIN is set (new days are locked only when it is).</summary>
    private async Task<(bool PinSet, string? TimeZone)> WhoAsync(string userId, CancellationToken ct)
    {
        if (_scopes is null || !int.TryParse(userId, out var id)) return (false, null);
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.Users.Where(u => u.Id == id).Select(u => new { u.TimeZone, Pin = u.VaultPinHash }).FirstOrDefaultAsync(ct);
        return (!string.IsNullOrEmpty(row?.Pin), row?.TimeZone);
    }

    // ── Files named for their day ───────────────────────────────────────────

    private async Task<List<ImportedDay>> ReadDatedFilesAsync(ZipArchive zip, string mediaDir, ImportBudget budget, CancellationToken ct)
    {
        var root = ObsidianVaultRoot(zip);
        var media = MediaLookup(zip);
        var landed = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var byDay = new SortedDictionary<DateOnly, (List<string> Bodies, List<string> Tags, int? Mood)>();

        foreach (var entry in zip.Entries.OrderBy(e => e.FullName, StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(entry.Name) || !entry.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
            if (IsHiddenPath(RelativePath(entry.FullName, root))) continue;
            if (DatedName().Match(Path.GetFileNameWithoutExtension(entry.Name)) is not { Success: true } m
                || !JournalPaths.TryParseDate(m.Groups["d"].Value, out var day)) continue;

            ct.ThrowIfCancellationRequested();
            var note = _storage.Deserialize(await ReadEntryTextAsync(entry, ct));
            var body = note.Body?.Trim() ?? string.Empty;
            if (body.Length == 0) continue;

            // The pictures and recordings it names come with it, under names that can't clobber anything here.
            var renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in MediaRefParser.Extract(body))
            {
                if (FindMedia(media, name) is not { } file) continue;
                if (!landed.TryGetValue(file.FullName, out var stored))
                    landed[file.FullName] = stored = await LandMediaAsync(file, mediaDir, budget, ct);
                if (stored is not null && !string.Equals(stored, name, StringComparison.Ordinal)) renames[name] = stored;
            }
            if (renames.Count > 0) body = MediaRefParser.Rename(body, renames);

            int? mood = note.ExtraFrontmatter.FirstOrDefault(kv => string.Equals(kv.Key, "mood", StringComparison.OrdinalIgnoreCase)).Value is { } raw
                && int.TryParse(raw.ToString(), out var v) && v is >= 1 and <= 5 ? v : null;
            var tags = note.Tags.Select(t => t.Trim().TrimStart('#')).Where(t => t.Length > 0).ToList();

            if (!byDay.TryGetValue(day, out var bucket)) byDay[day] = bucket = ([], [], null);
            bucket.Bodies.Add(body);
            bucket.Tags.AddRange(tags);
            byDay[day] = (bucket.Bodies, bucket.Tags, bucket.Mood ?? mood);
        }

        return byDay.Select(kv => new ImportedDay(kv.Key, string.Join("\n\n", kv.Value.Bodies), TagPolicy.Normalize(kv.Value.Tags), kv.Value.Mood)).ToList();
    }

    // ── Day One ─────────────────────────────────────────────────────────────

    private async Task<List<ImportedDay>> ReadDayOneAsync(
        ZipArchive zip, string mediaDir, ImportBudget budget, string? userZone, CancellationToken ct)
    {
        var jsonEntry = zip.Entries.FirstOrDefault(e => e.Name.Equals("Journal.json", StringComparison.OrdinalIgnoreCase))
            ?? zip.Entries.Where(e => e.Name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                    && !e.FullName.Contains("__MACOSX", StringComparison.Ordinal))
                .OrderByDescending(e => e.Length).FirstOrDefault()
            ?? throw new InvalidDataException("This doesn’t look like a Day One export: there is no Journal.json in it.");

        using var doc = JsonDocument.Parse(await ReadEntryTextAsync(jsonEntry, ct));
        if (!doc.RootElement.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("This doesn’t look like a Day One export: it has no entries.");

        // Attachments are named by their checksum (or id); the entry lists which belong to it.
        var files = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in zip.Entries)
            if (!string.IsNullOrEmpty(e.Name) && !e.Name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                files.TryAdd(Path.GetFileNameWithoutExtension(e.Name), e);
        var landed = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        var byDay = new SortedDictionary<DateOnly, List<(DateTimeOffset At, string Body)>>();
        var tagsByDay = new Dictionary<DateOnly, List<string>>();

        foreach (var item in entries.EnumerateArray())
        {
            ct.ThrowIfCancellationRequested();
            var text = Str(item, "text");
            if (string.IsNullOrWhiteSpace(text)) continue;
            if (!DateTimeOffset.TryParse(Str(item, "creationDate"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)) continue;

            var local = at;
            foreach (var zone in new[] { Str(item, "timeZone"), userZone })
            {
                if (string.IsNullOrEmpty(zone)) continue;
                try { local = TimeZoneInfo.ConvertTime(at, TimeZoneInfo.FindSystemTimeZoneById(zone)); break; }
                catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { /* try the next */ }
            }
            var day = DateOnly.FromDateTime(local.DateTime);

            // Every attachment the entry lists, by the id its text points at.
            var stored = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kind in new[] { "photos", "audios", "videos", "pdfAttachments" })
            {
                if (!item.TryGetProperty(kind, out var list) || list.ValueKind != JsonValueKind.Array) continue;
                foreach (var attachment in list.EnumerateArray())
                {
                    var id = Str(attachment, "identifier");
                    if (id.Length == 0) continue;
                    var file = files.GetValueOrDefault(Str(attachment, "md5")) ?? files.GetValueOrDefault(id);
                    if (file is null) continue;
                    if (!landed.TryGetValue(file.FullName, out var name))
                        landed[file.FullName] = name = await LandMediaAsync(file, mediaDir, budget, ct);
                    if (name is not null) stored[id] = name;
                }
            }

            var body = DayOneMoment().Replace(text, m => stored.TryGetValue(m.Groups["id"].Value, out var n) ? $"![[{n}]]" : string.Empty);
            body = DayOneEscape().Replace(body, "$1").Trim();
            if (body.Length == 0) continue;

            if (!byDay.TryGetValue(day, out var list2)) byDay[day] = list2 = [];
            list2.Add((at, body));
            if (item.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
            {
                if (!tagsByDay.TryGetValue(day, out var t)) tagsByDay[day] = t = [];
                t.AddRange(tags.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x))!);
            }
        }

        return byDay.Select(kv => new ImportedDay(
            kv.Key,
            string.Join("\n\n", kv.Value.OrderBy(x => x.At).Select(x => x.Body)),
            TagPolicy.Normalize(tagsByDay.GetValueOrDefault(kv.Key)),
            null)).ToList();
    }
}
