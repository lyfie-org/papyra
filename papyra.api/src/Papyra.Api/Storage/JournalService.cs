using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Collab;
using Papyra.Api.Hubs;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>What a journal write may carry. Absent fields keep what the entry already has.</summary>
public sealed class JournalWrite
{
    public string? Body { get; set; }
    /// <summary>Absent = keep, <c>null</c> = clear, 1–5 = set.</summary>
    public JsonElement Mood { get; set; }
    public List<string>? Tags { get; set; }
    public bool? Archived { get; set; }
    public bool? Secure { get; set; }
    /// <summary>Hash of the body this edit was made against (also accepted as <c>If-Match</c>).</summary>
    public string? BaseHash { get; set; }

    /// <summary>For appends: derive the new body from the current one while the write lock is held.</summary>
    [JsonIgnore] public Func<string, string>? Transform { get; set; }

    /// <summary>Archive the revision this write replaces even inside the snapshot throttle (an offline edit replayed over a newer one).</summary>
    [JsonIgnore] public bool ForceSnapshot { get; set; }
}

/// <summary>Who is writing: the person, or a script on an API key (history credits "via key-name").</summary>
public sealed record JournalActor(bool IsKey, int Contributor, string Name)
{
    public static readonly JournalActor Owner = new(false, 0, string.Empty);
}

public enum JournalStatus { Ok, NoOp, Stale, Future, Invalid, Locked, PinNotSet, UnlockRequired, Trashed }

public sealed record JournalResult(JournalStatus Status, Note? Note = null, string? Error = null, string? CurrentBody = null);

/// <summary>One line of a month, a year or "on this day".</summary>
public sealed record JournalSummary(
    string Date, int? Mood, IReadOnlyList<string> Tags, int Words, bool HasMedia, bool Locked, bool Archived,
    bool Trashed, string? Cover, string? Excerpt, DateTime Updated, DateTime? TrashedAt = null);

public sealed record JournalStats(
    int Current, int Longest, int TotalDays, long TotalWords, int ThisMonth, bool TodayWritten, string? StreakEndsOn);

/// <summary>
/// Reads and writes journal entries: <c>Kind = "journal"</c> notes at
/// <c>journal/yyyy/MM/yyyy-MM-dd.md</c> under the notes dir. The filesystem is
/// the truth; <see cref="VaultState"/> is the mirror. An entry is created lazily
/// by its first real write — an empty body with no mood never produces a file.
/// A write is: lock the entry, read the file, check the revision the caller made
/// its edit against, snapshot what's on disk, write atomically, update the mirror
/// and the search index. Journal text is personal — it is never embedded, never
/// archived, never scanned for @mentions and never fires a webhook.
/// </summary>
public sealed partial class JournalService(
    VaultState state, MarkdownStorageService storage, WriteRing writeRing, SearchIndexService search,
    SnapshotService snapshots, MediaJobQueue mediaJobs, NoteWriteLocks writeLocks, LockedNoteSealer sealer,
    JournalSettings settings, VaultObserverOptions vault, IConfiguration config, IHostEnvironment env,
    IHubContext<NotesHub> hub, TimeProvider clock, ILoggerFactory lf)
{
    public const int MaxBody = 1_000_000;

    [GeneratedRegex(@"!\[\[[^\]]*\]\]|https?://\S+|\^[A-Za-z0-9_-]+")]
    private static partial Regex NonWords();

    // A run of letters is a word; each kana/ideograph counts as its own (no spaces to count by).
    [GeneratedRegex(@"[぀-ヿ㐀-䶿一-鿿]|[\p{L}\p{N}][\p{L}\p{N}'’\-]*")]
    private static partial Regex Word();

    [GeneratedRegex(@"^[ \t]*[-*+][ \t]+\[ \][ \t]+\S.*$", RegexOptions.Multiline)]
    private static partial Regex OpenChecklistItem();

    [GeneratedRegex(@"!\[\[(?<name>[^\]|#]+?\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp))(?:\|[^\]]*)?\]\]", RegexOptions.IgnoreCase)]
    private static partial Regex ImageEmbed();

    // ── Reading ──────────────────────────────────────────────────────────────

    public Note? Get(string uid, DateOnly day) =>
        state.PathFor(uid, JournalPaths.IdFor(day)) is { } p && state.TryGet(uid, p, out var n) ? n : null;

    public DateOnly Today(string uid, string? timeZone) =>
        JournalClock.Today(clock, timeZone, settings.Read(uid).DayStartsAt);

    public static int? MoodOf(Note note) =>
        note.ExtraFrontmatter.TryGetValue(MarkdownStorageService.KeyMood, out var m)
        && int.TryParse(m?.ToString(), out var v) && v is >= 1 and <= 5 ? v : null;

    public static int WordsOf(Note note)
    {
        if (note.Secure)
            return note.ExtraFrontmatter.TryGetValue(MarkdownStorageService.KeyWords, out var w)
                   && int.TryParse(w?.ToString(), out var n) ? n : 0;
        return CountWords(note.Body);
    }

    public static int CountWords(string? body) =>
        string.IsNullOrWhiteSpace(body) ? 0 : Word().Matches(NonWords().Replace(body, " ")).Count;

    /// <summary>A day counts toward the streak when it has words or a mood and isn't in the bin.</summary>
    public static bool Counts(Note note) => !note.Trashed && (WordsOf(note) > 0 || MoodOf(note) is not null);

    public static string Etag(string body) => LiveAgentEdits.ETag(body);

    public IReadOnlyList<JournalSummary> Summaries(string uid, DateOnly from, DateOnly to, bool withExcerpt = false)
    {
        var list = new List<JournalSummary>();
        foreach (var note in state.SnapshotJournal(uid))
        {
            if (!JournalPaths.TryDateFromId(note.Id, out var day) || day < from || day > to) continue;
            list.Add(Summarize(note, day, withExcerpt));
        }
        return list.OrderBy(s => s.Date, StringComparer.Ordinal).ToList();
    }

    public JournalSummary Summarize(Note note, DateOnly day, bool withExcerpt = false)
    {
        var cover = note.Secure ? null : ImageEmbed().Match(note.Body ?? string.Empty) is { Success: true } m ? m.Groups["name"].Value : null;
        var hasMedia = !note.Secure && (note.Body ?? string.Empty).Contains("![[", StringComparison.Ordinal);
        string? excerpt = null;
        if (withExcerpt && !note.Secure)
        {
            var flat = PlainText.Flatten(note.Body).Trim();
            excerpt = flat.Length > 180 ? flat[..180].TrimEnd() + "…" : flat;
        }
        return new JournalSummary(JournalClock.Format(day), MoodOf(note), note.Tags, WordsOf(note), hasMedia,
            note.Secure, note.Archived, note.Trashed, cover, excerpt, DateTime.SpecifyKind(note.Updated, DateTimeKind.Utc),
            note.Trashed && note.TrashedAt is { } at ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : null);
    }

    /// <summary>The days set aside: archived ones, or the ones in the Trash (with when they went), newest day first.</summary>
    public IReadOnlyList<JournalSummary> Bin(string uid, bool trashed)
    {
        var list = new List<JournalSummary>();
        foreach (var note in state.SnapshotJournal(uid))
        {
            if (!(trashed ? note.Trashed : note.Archived && !note.Trashed)) continue;
            if (!JournalPaths.TryDateFromId(note.Id, out var day)) continue;
            list.Add(Summarize(note, day));
        }
        return list.OrderByDescending(s => s.Date, StringComparer.Ordinal).ToList();
    }

    public JournalStats Stats(string uid, DateOnly today) => ComputeStats(state.SnapshotJournal(uid), today);

    /// <summary>The streak and totals of a set of entries, as of <paramref name="today"/>.</summary>
    public static JournalStats ComputeStats(IEnumerable<Note> entries, DateOnly today)
    {
        var days = new SortedSet<DateOnly>();
        long words = 0;
        foreach (var note in entries)
        {
            if (!JournalPaths.TryDateFromId(note.Id, out var day) || !Counts(note)) continue;
            days.Add(day);
            words += WordsOf(note);
        }

        var longest = 0;
        var run = 0;
        DateOnly? prev = null;
        foreach (var d in days)
        {
            run = prev is { } p && p.AddDays(1) == d ? run + 1 : 1;
            longest = Math.Max(longest, run);
            prev = d;
        }

        // Today unwritten keeps the streak alive through yesterday: it only ends
        // once a whole day has passed with nothing written.
        var written = days.Contains(today);
        var cursor = written ? today : today.AddDays(-1);
        var current = 0;
        var end = cursor;
        while (days.Contains(cursor)) { current++; cursor = cursor.AddDays(-1); }

        return new JournalStats(current, Math.Max(longest, current), days.Count, words,
            days.Count(d => d.Year == today.Year && d.Month == today.Month), written,
            current > 0 ? JournalClock.Format(end) : null);
    }

    /// <summary>Earlier years' entries for this month and day, newest first.</summary>
    public IReadOnlyList<JournalSummary> OnThisDay(string uid, DateOnly day)
    {
        var list = new List<JournalSummary>();
        foreach (var note in state.SnapshotJournal(uid))
        {
            if (!JournalPaths.TryDateFromId(note.Id, out var d) || d.Year >= day.Year
                || d.Month != day.Month || d.Day != day.Day || !Counts(note)) continue;
            list.Add(Summarize(note, d, withExcerpt: true));
        }
        // A 29 February has no anniversary in a common year: show it on the 28th.
        if (day is { Month: 2, Day: 28 } && !DateTime.IsLeapYear(day.Year))
            foreach (var note in state.SnapshotJournal(uid))
                if (JournalPaths.TryDateFromId(note.Id, out var d) && d is { Month: 2, Day: 29 } && Counts(note))
                    list.Add(Summarize(note, d, withExcerpt: true));
        return list.OrderByDescending(s => s.Date, StringComparer.Ordinal).ToList();
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    public async Task<JournalResult> WriteAsync(
        string uid, DateOnly day, JournalWrite w, JournalActor actor, string? timeZone,
        bool pinSet, bool unlockedNow, CancellationToken ct)
    {
        var prefs = settings.Read(uid);
        if (day > JournalClock.Today(clock, timeZone, prefs.DayStartsAt))
            return new JournalResult(JournalStatus.Future, Error: "A journal day can't be written before it begins.");
        if (w.Body is { Length: > MaxBody })
            return new JournalResult(JournalStatus.Invalid, Error: "That entry is too long.");

        int? moodIn = null;
        var moodTouched = w.Mood.ValueKind != JsonValueKind.Undefined;
        if (moodTouched && w.Mood.ValueKind != JsonValueKind.Null)
        {
            if (w.Mood.ValueKind != JsonValueKind.Number || !w.Mood.TryGetInt32(out var mv) || mv is < 1 or > 5)
                return new JournalResult(JournalStatus.Invalid, Error: "Mood is a number from 1 to 5.");
            moodIn = mv;
        }

        var id = JournalPaths.IdFor(day);
        var notesDir = vault.UserNotesDir(uid);
        using var writeLock = await writeLocks.AcquireAsync(uid, id, ct);

        var existingPath = state.PathFor(uid, id);
        var path = existingPath ?? JournalPaths.PathFor(notesDir, day);
        PathGuard.ResolveAndVerify(notesDir, Path.GetRelativePath(notesDir, path), lf.CreateLogger("PathGuard"));

        var prior = existingPath is not null && File.Exists(existingPath) ? await storage.ReadAsync(existingPath, ct) : null;
        if (prior is not null && !JournalPaths.IsJournal(prior)) prior = null; // a stray file with that id: never overwrite it as an entry
        if (prior is { Trashed: true })
            return new JournalResult(JournalStatus.Trashed, Error: "This day is in the Trash. Restore it to write here.");

        var wasSecure = prior?.Secure ?? false;
        var wantsSecure = w.Secure ?? (prior is null ? prefs.LockNewEntries && pinSet : wasSecure);
        switch (NoteWriteGuards.CheckLockChange(wasSecure, wantsSecure, pinSet, unlockedNow))
        {
            case NoteWriteGuards.LockChange.NeedsPin:
                return new JournalResult(JournalStatus.PinNotSet, Error: "Set a vault PIN before locking an entry.");
            case NoteWriteGuards.LockChange.NeedsUnlock:
                return new JournalResult(JournalStatus.UnlockRequired, Error: "Unlock the vault to take the lock off an entry.");
        }

        var priorBody = prior?.Body ?? string.Empty;
        string body;
        if (w.Transform is not null) body = w.Transform(priorBody);
        else if (w.Body is null) body = priorBody;
        // A list-built save never saw a locked body, so it sends none: keep the stored one.
        else if (NoteWriteGuards.KeepsLockedBody(wasSecure, wantsSecure, w.Body, unlockedNow, prior is not null)) body = priorBody;
        else body = w.Body;

        // The caller read some version of the body; refuse to write over a newer one.
        if (w.BaseHash is not null && prior is not null && body != priorBody && CollabHash.Of(priorBody) != w.BaseHash)
            return new JournalResult(JournalStatus.Stale, CurrentBody: prior.Secure && !unlockedNow ? string.Empty : priorBody);

        var mood = moodTouched ? moodIn : (prior is null ? null : MoodOf(prior));
        if (prior is null && string.IsNullOrWhiteSpace(body) && mood is null)
            return new JournalResult(JournalStatus.NoOp);

        var tags = w.Tags is null ? prior?.Tags ?? [] : TagPolicy.Normalize(w.Tags);
        if (w.Tags is not null && TagPolicy.Validate(tags, prior?.Tags.Count ?? 0) is { } badTags)
            return new JournalResult(JournalStatus.Invalid, Error: badTags);

        var note = prior ?? new Note { Id = id, Title = JournalClock.Format(day), Kind = JournalPaths.Kind };
        var changed = prior is null
            || note.Body != body || MoodOf(note) != mood || !note.Tags.SequenceEqual(tags, StringComparer.Ordinal)
            || note.Archived != (w.Archived ?? note.Archived) || note.Secure != wantsSecure;
        if (!changed) return new JournalResult(JournalStatus.Ok, prior);

        note.Body = body;
        note.Tags = tags;
        note.Archived = w.Archived ?? note.Archived;
        note.Secure = wantsSecure;
        note.Title = JournalClock.Format(day);
        note.Kind = JournalPaths.Kind;
        note.Updated = DateTime.UtcNow;
        if (mood is { } mi) note.ExtraFrontmatter[MarkdownStorageService.KeyMood] = mi;
        else note.ExtraFrontmatter.Remove(MarkdownStorageService.KeyMood);
        // A locked body is withheld, so the streak and calendar read its size from here.
        if (note.Secure) note.ExtraFrontmatter[MarkdownStorageService.KeyWords] = CountWords(body);
        else note.ExtraFrontmatter.Remove(MarkdownStorageService.KeyWords);

        var snapRoot = PapyraPaths.UserSnapshotsDir(config, env.ContentRootPath, uid);
        var noteSnapDir = PathGuard.ResolveAndVerify(snapRoot, id, lf.CreateLogger("PathGuard"));
        if (prior is not null)
            await snapshots.CaptureAsync(noteSnapDir, path, ct, force: w.ForceSnapshot || snapshots.IsForeign(noteSnapDir, path));

        writeRing.Mark(path);
        await storage.WriteAsync(path, note, ct);
        snapshots.RememberSaved(noteSnapDir, path);
        state.Upsert(uid, path, note);
        search.IndexNote(uid, note);
        if (note.Secure && !wasSecure && prior is not null) await sealer.SealHistoryAsync(uid, id, ct);
        mediaJobs.EnqueueNewRefs(uid, priorBody, note.Body);

        if (actor.IsKey)
        {
            // Make this revision a version of its own, credited to the key.
            if (await snapshots.CaptureAsync(noteSnapDir, path, ct, force: true) is { } versionId)
                snapshots.SetContributors(noteSnapDir, versionId, [actor.Contributor]);
            await hub.Clients.User(uid).SendAsync("NoteUpdated", NoteMetadata.From(note), ct);
        }
        return new JournalResult(JournalStatus.Ok, note);
    }

    /// <summary>
    /// Lock every entry that isn't (the settings sweep). Each goes through the ordinary write, so
    /// its history is sealed and its words are kept in the clear for the calendar; trashed days are
    /// left as they are. Needs the vault PIN, like any lock. Returns how many it locked.
    /// </summary>
    public async Task<(JournalResult? Refused, int Locked)> LockAllAsync(
        string uid, string? timeZone, bool pinSet, CancellationToken ct)
    {
        if (!pinSet)
            return (new JournalResult(JournalStatus.PinNotSet, Error: "Set a vault PIN before locking entries."), 0);
        var locked = 0;
        foreach (var note in state.SnapshotJournal(uid).Where(n => !n.Secure && !n.Trashed).ToList())
        {
            if (!JournalPaths.TryDateFromId(note.Id, out var day)) continue;
            var result = await WriteAsync(uid, day, new JournalWrite { Secure = true }, JournalActor.Owner, timeZone, pinSet, false, ct);
            if (result.Status == JournalStatus.Ok && result.Note?.Secure == true) locked++;
        }
        return (null, locked);
    }

    /// <summary>The unticked checklist lines of a body, in order (`- [ ] …`).</summary>
    public static IReadOnlyList<string> OpenItems(string? body) =>
        string.IsNullOrEmpty(body) ? [] : OpenChecklistItem().Matches(body).Select(m => m.Value.TrimEnd('\r').TrimEnd()).ToList();

    /// <summary>
    /// The most recent earlier entry that still has unticked checklist items and can be
    /// read (not locked, not trashed). Locked days are skipped, never opened.
    /// </summary>
    public Note? LastOpenDayBefore(string uid, DateOnly day)
    {
        Note? best = null;
        DateOnly bestDay = default;
        foreach (var note in state.SnapshotJournal(uid))
        {
            if (note.Secure || note.Trashed || !JournalPaths.TryDateFromId(note.Id, out var d) || d >= day) continue;
            if (best is not null && d <= bestDay) continue;
            if (OpenItems(note.Body).Count == 0) continue;
            (best, bestDay) = (note, d);
        }
        return best;
    }

    /// <summary>
    /// Carry what's still open forward: copy the unticked items of the latest earlier day
    /// into <paramref name="day"/>, skipping any already there — so pressing it twice, or
    /// after typing some of them by hand, adds nothing twice. The source day is untouched.
    /// </summary>
    public async Task<(JournalResult Result, int Carried)> CarryOverAsync(
        string uid, DateOnly day, JournalActor actor, string? timeZone, bool pinSet, bool unlockedNow, CancellationToken ct)
    {
        var source = LastOpenDayBefore(uid, day);
        if (source is null) return (new JournalResult(JournalStatus.NoOp, Get(uid, day)), 0);
        var items = OpenItems(source.Body);
        var carried = 0;
        var write = new JournalWrite
        {
            Transform = current =>
            {
                var have = OpenItems(current).Select(i => i.Trim()).ToHashSet(StringComparer.Ordinal);
                var fresh = items.Where(i => !have.Contains(i.Trim())).ToList();
                carried = fresh.Count;
                if (fresh.Count == 0) return current;
                var block = string.Join("\n", fresh);
                return current.Length == 0 ? block : current.TrimEnd('\r', '\n') + "\n\n" + block;
            },
        };
        var result = await WriteAsync(uid, day, write, actor, timeZone, pinSet, unlockedNow, ct);
        return (result, carried);
    }

    /// <summary>Atomic append — the verb an agent wants ("log this to today").</summary>
    public Task<JournalResult> AppendAsync(
        string uid, DateOnly day, string text, string? heading, JournalActor actor, string? timeZone,
        bool pinSet, bool unlockedNow, CancellationToken ct)
    {
        var add = text.Trim('\r', '\n');
        var w = new JournalWrite
        {
            Transform = current =>
            {
                if (string.IsNullOrWhiteSpace(heading))
                    return current.Length == 0 ? add : current.TrimEnd('\r', '\n') + "\n\n" + add;
                var h = heading.Trim().TrimStart('#').Trim();
                var section = NoteSections.Apply(current, [new SectionOp("append", h, null, null, add)]);
                if (section.Body is not null) return section.Body;
                var block = $"## {h}\n\n{add}";
                return current.Length == 0 ? block : current.TrimEnd('\r', '\n') + "\n\n" + block;
            },
        };
        return WriteAsync(uid, day, w, actor, timeZone, pinSet, unlockedNow, ct);
    }
}
