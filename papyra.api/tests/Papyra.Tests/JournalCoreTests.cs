using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>The pure parts of the journal: the day boundary, dated paths, the file format, the streak.</summary>
public sealed class JournalCoreTests
{
    // ── Day boundary ────────────────────────────────────────────────────────────

    // (zone, UTC instant, dayStartsAt) → the journal day. Shared with the web fixtures
    // (papyra.web/src/lib/journalDay.test.ts) so the client and server agree.
    [Theory]
    [InlineData("America/New_York", "2026-10-25T03:30:00Z", 0, "2026-10-24")]   // 23:30 EDT the night before
    [InlineData("America/New_York", "2026-10-25T04:00:00Z", 0, "2026-10-25")]   // midnight EDT exactly
    [InlineData("America/New_York", "2026-11-01T05:30:00Z", 0, "2026-11-01")]   // 01:30 EDT, first pass of the repeated hour
    [InlineData("America/New_York", "2026-11-01T06:30:00Z", 0, "2026-11-01")]   // 01:30 EST, second pass
    [InlineData("America/New_York", "2026-03-08T06:59:00Z", 0, "2026-03-08")]   // 01:59 EST, just before the spring gap
    [InlineData("America/New_York", "2026-03-08T07:00:00Z", 0, "2026-03-08")]   // 03:00 EDT, the hour that never was is skipped
    [InlineData("Europe/London", "2026-03-29T00:59:00Z", 0, "2026-03-29")]
    [InlineData("Europe/London", "2026-10-25T00:30:00Z", 0, "2026-10-25")]      // 01:30 BST, clocks go back at 02:00
    [InlineData("Europe/London", "2026-10-25T23:59:00Z", 0, "2026-10-25")]
    [InlineData("Pacific/Auckland", "2026-10-24T11:30:00Z", 0, "2026-10-25")]   // already tomorrow in NZ
    [InlineData("Asia/Kolkata", "2026-10-24T18:29:00Z", 0, "2026-10-24")]       // 23:59 IST
    [InlineData("Asia/Kolkata", "2026-10-24T18:30:00Z", 0, "2026-10-25")]       // 00:00 IST
    [InlineData("Asia/Kolkata", "2026-10-24T20:00:00Z", 3, "2026-10-24")]       // 01:30 IST, night owl: still the 24th
    [InlineData("Asia/Kolkata", "2026-10-24T21:30:00Z", 3, "2026-10-25")]       // 03:00 IST: the 25th begins
    [InlineData("America/New_York", "2026-11-01T06:30:00Z", 2, "2026-10-31")]   // 01:30 EST with a 2 a.m. day start
    [InlineData("Not/AZone", "2026-10-25T23:30:00Z", 0, "2026-10-25")]          // unknown zone → UTC
    [InlineData(null, "2026-10-25T00:00:00Z", 0, "2026-10-25")]
    [InlineData("UTC", "2026-10-25T01:00:00Z", 99, "2026-10-24")]               // day start is clamped to 5
    public void Today_FollowsTheZoneAndTheDayStart(string? zone, string utc, int dayStartsAt, string expected)
    {
        var day = JournalClock.Today(DateTimeOffset.Parse(utc, System.Globalization.CultureInfo.InvariantCulture), zone, dayStartsAt);
        Assert.Equal(expected, JournalClock.Format(day));
    }

    [Fact]
    public void EndOfDay_IsTheNextDaysStart_AndSurvivesAGap()
    {
        var end = JournalClock.EndOfDay(new DateOnly(2026, 10, 25), "Asia/Kolkata", 3);
        Assert.Equal(DateTimeOffset.Parse("2026-10-25T21:30:00Z"), end.ToUniversalTime());
        // 02:30 on 8 March 2026 doesn't exist in New York: the end of the 7th must still resolve.
        var gap = JournalClock.EndOfDay(new DateOnly(2026, 3, 7), "America/New_York", 2);
        Assert.Equal(new DateOnly(2026, 3, 8), JournalClock.Today(gap, "America/New_York", 2));
    }

    // ── Dates and paths ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("2026-10-25", true)]
    [InlineData("2024-02-29", true)]       // a leap day
    [InlineData("2026-02-29", false)]      // not one
    [InlineData("2026-02-30", false)]
    [InlineData("2026-13-01", false)]
    [InlineData("2026-1-5", false)]
    [InlineData("2026-10-5", false)]
    [InlineData("26-10-25", false)]
    [InlineData(" 2026-10-25", false)]
    [InlineData("2026-10-25 ", false)]
    [InlineData("2026/10/25", false)]
    [InlineData("2026-10-25T00:00", false)]
    [InlineData("..", false)]
    [InlineData("../../etc/passwd", false)]
    [InlineData("..\\..\\x", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("1899-12-31", false)]
    [InlineData("٢٠٢٦-١٠-٢٥", false)]    // non-ASCII digits
    public void TryParseDate_IsStrict(string? text, bool ok) => Assert.Equal(ok, JournalPaths.TryParseDate(text, out _));

    [Fact]
    public void ThePath_IsADatedFile_UnderTheNotesDir()
    {
        var path = JournalPaths.PathFor(Path.Combine("data", "notes"), new DateOnly(2026, 3, 7));
        Assert.EndsWith(Path.Combine("journal", "2026", "03", "2026-03-07.md"), path);
        Assert.Equal("journal-2026-03-07", JournalPaths.IdFor(new DateOnly(2026, 3, 7)));
        Assert.True(JournalPaths.TryDateFromId("journal-2026-03-07", out var d));
        Assert.Equal(new DateOnly(2026, 3, 7), d);
        Assert.False(JournalPaths.IsJournalId("journal-2026-3-7"));
        Assert.False(JournalPaths.IsJournalId("journal-"));
        Assert.False(JournalPaths.IsJournalId("my-journal-2026-03-07"));
    }

    [Theory]
    [InlineData("/api/notes/journal-2026-10-25/sections", true)]
    [InlineData("/api/media/upload?noteId=journal-2026-10-25", true)]
    [InlineData("/api/notes/groceries", false)]
    [InlineData("/api/notes/journal-notes", false)]
    public void ARequestNamingAnEntry_IsRecognised(string pathAndQuery, bool names) =>
        Assert.Equal(names, JournalPaths.NamesAnEntry(pathAndQuery));

    // ── The file ────────────────────────────────────────────────────────────────

    [Fact]
    public void AnEntry_RoundTripsThroughFrontmatter_WithKindAndMood()
    {
        var storage = new MarkdownStorageService();
        var note = new Note
        {
            Id = "journal-2026-10-25", Title = "2026-10-25", Kind = "journal", Body = "Walked home.",
            Tags = ["grateful"], ExtraFrontmatter = new() { ["mood"] = 4 },
        };
        var md = storage.Serialize(note);

        Assert.Contains("kind: journal", md);
        Assert.Contains("mood: 4", md);
        Assert.DoesNotContain("mood: '4'", md);

        var back = storage.Deserialize(md);
        Assert.Equal("journal", back.Kind);
        Assert.Equal(4, JournalService.MoodOf(back));

        // A save that carried the mood back as the text YAML read it must not quote it.
        var again = storage.Serialize(back);
        Assert.Contains("mood: 4", again);
        Assert.DoesNotContain("mood: '4'", again);
    }

    [Fact]
    public void TheJournalKind_DoesNotRevertToANote()
    {
        var storage = new MarkdownStorageService();
        var md = storage.Serialize(new Note { Id = "journal-2026-10-25", Title = "2026-10-25", Kind = "journal", Body = "x" });
        Assert.Equal("journal", storage.Deserialize(md).Kind);
        // …and a plain note still doesn't stamp a kind.
        Assert.DoesNotContain("kind:", storage.Serialize(new Note { Id = "n", Title = "t", Body = "x" }));
    }

    [Fact]
    public void AnEntryFile_IsNeverRenamed_LockedOrNot()
    {
        var entry = new Note { Id = "journal-2026-10-25", Title = "2026-10-25", Kind = "journal", Body = "hello world there" };
        var path = Path.Combine("notes", "journal", "2026", "10", "2026-10-25.md");
        Assert.Null(NoteFileNamer.DesiredBaseName(entry));
        Assert.Equal(path, NoteFileNamer.TargetPath(path, NoteFileNamer.DesiredBaseName(entry), entry.Id));
        entry.Secure = true;
        Assert.Null(NoteFileNamer.DesiredBaseName(entry));
        Assert.Equal(path, NoteFileNamer.TargetPath(path, NoteFileNamer.DesiredBaseName(entry), entry.Id));
    }

    // ── The streak ──────────────────────────────────────────────────────────────

    private static Note Day(string date, string body = "words here", int? mood = null, bool trashed = false, bool secure = false, int words = 0)
    {
        var n = new Note { Id = "journal-" + date, Title = date, Kind = "journal", Body = body, Trashed = trashed, Secure = secure };
        if (mood is { } m) n.ExtraFrontmatter["mood"] = m;
        if (secure) n.ExtraFrontmatter["words"] = words;
        return n;
    }

    private static JournalStats Stats(string today, params Note[] entries) =>
        JournalService.ComputeStats(entries, DateOnly.Parse(today));

    [Fact]
    public void Streak_CountsConsecutiveDays_EndingToday()
    {
        var s = Stats("2026-10-25", Day("2026-10-23"), Day("2026-10-24"), Day("2026-10-25"));
        Assert.Equal(3, s.Current);
        Assert.Equal(3, s.Longest);
        Assert.True(s.TodayWritten);
        Assert.Equal("2026-10-25", s.StreakEndsOn);
    }

    [Fact]
    public void Streak_StaysAliveThroughYesterday_WhenTodayIsUnwritten()
    {
        var s = Stats("2026-10-25", Day("2026-10-23"), Day("2026-10-24"));
        Assert.Equal(2, s.Current);
        Assert.False(s.TodayWritten);
        Assert.Equal("2026-10-24", s.StreakEndsOn);
    }

    [Fact]
    public void Streak_EndsAfterAWholeMissedDay_ButLongestIsKept()
    {
        var s = Stats("2026-10-25", Day("2026-10-20"), Day("2026-10-21"), Day("2026-10-22"), Day("2026-10-23"));
        Assert.Equal(0, s.Current);
        Assert.Equal(4, s.Longest);
        Assert.Null(s.StreakEndsOn);
    }

    [Fact]
    public void Streak_ADayCountsWithAMoodAlone_ButNotWhenEmpty_OrInTheBin()
    {
        var s = Stats("2026-10-25",
            Day("2026-10-23", body: "", mood: 3),              // mood only: counts
            Day("2026-10-24", body: "   "),                    // blank: doesn't
            Day("2026-10-25", trashed: true));                 // trashed: doesn't
        Assert.Equal(0, s.Current);
        Assert.Equal(1, s.TotalDays);
    }

    [Fact]
    public void Streak_ALockedDayCounts_ByItsRecordedWords()
    {
        // A locked body is withheld, so the file records how many words it holds.
        var s = Stats("2026-10-25", Day("2026-10-24", body: "", secure: true, words: 40), Day("2026-10-25", body: "", secure: true, words: 0));
        Assert.Equal(1, s.Current);
        Assert.Equal(40, s.TotalWords);
    }

    [Fact]
    public void Streak_AcrossLeapDayAndYearEnd()
    {
        var s = Stats("2025-01-02", Day("2024-12-31"), Day("2025-01-01"), Day("2025-01-02"));
        Assert.Equal(3, s.Current);
        var leap = Stats("2024-03-01", Day("2024-02-28"), Day("2024-02-29"), Day("2024-03-01"));
        Assert.Equal(3, leap.Current);
    }

    [Theory]
    [InlineData("", 0)]
    [InlineData("Walked home.", 2)]
    [InlineData("It's a well-known thing — really", 5)]
    [InlineData("![[photo.png]] a picture https://example.com/x here", 3)]
    [InlineData("日本語 text", 4)]
    public void WordCount_IgnoresEmbedsAndLinks(string body, int words) => Assert.Equal(words, JournalService.CountWords(body));

    [Fact]
    public void Snapshots_SeparateTheDeskFromTheJournal()
    {
        var state = new VaultState();
        state.Upsert("1", "/n/a.md", new Note { Id = "a", Title = "Note", Body = "x" });
        state.Upsert("1", "/n/j.md", Day("2026-10-25"));
        Assert.Equal(2, state.SnapshotAll("1").Count);
        Assert.Equal("a", Assert.Single(state.SnapshotDesk("1")).Id);
        Assert.Equal("journal-2026-10-25", Assert.Single(state.SnapshotJournal("1")).Id);
        Assert.Empty(state.SnapshotJournal("2")); // another tenant sees nothing
    }
}
