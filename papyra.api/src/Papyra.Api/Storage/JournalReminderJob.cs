using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// The daily nudge, for people who asked for one (Settings → Journal; off by default):
// at their chosen time, in their own time zone, if today's page is still empty, one
// short email. It never says anything about what the journal holds. A day is
// reminded once — the day it was last sent for is kept in the person's journal
// settings, so a restart or a late sweep never sends it twice.
public sealed class JournalReminderJob : PeriodicJob
{
    private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(5);

    private readonly IServiceScopeFactory _scopes;
    private readonly VaultState _state;
    private readonly JournalSettings _settings;
    private readonly EmailSender _email;
    private readonly TimeProvider _clock;
    private readonly ILogger<JournalReminderJob> _logger;

    public JournalReminderJob(
        IServiceScopeFactory scopes, VaultState state, JournalSettings settings, EmailSender email,
        TimeProvider clock, JobRegistry registry, ILogger<JournalReminderJob> logger)
        : base(registry)
    {
        _scopes = scopes;
        _state = state;
        _settings = settings;
        _email = email;
        _clock = clock;
        _logger = logger;
    }

    protected override string JobId => "journal-reminder";
    protected override string JobName => "Journal reminder";
    protected override string JobDescription =>
        "Sends the daily email to people who turned on a journal reminder, at the time they chose, if that day is still blank.";
    protected override TimeSpan Interval => SweepEvery;

    /// <summary>
    /// The journal day to remind about right now, or null: not yet the hour, or already
    /// sent for that day. Pure, so the clock rules can be tested without a server.
    /// </summary>
    internal static DateOnly? DueDay(DateTimeOffset utcNow, string? timeZone, int dayStartsAt, string? reminderTime, string? sentFor)
    {
        if (!TimeOnly.TryParseExact(reminderTime, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var at)) return null;
        var local = TimeZoneInfo.ConvertTime(utcNow, JournalClock.ZoneOrUtc(timeZone));
        var day = JournalClock.Today(utcNow, timeZone, dayStartsAt);
        // The hour counts on the calendar day the journal day is named for: a 07:00 reminder is
        // not due at 02:00 on the next morning just because the day hasn't turned over yet.
        if (DateOnly.FromDateTime(local.DateTime) != day) return null;
        if (TimeOnly.FromDateTime(local.DateTime) < at) return null;
        return JournalClock.Format(day) == sentFor ? null : day;
    }

    protected override async Task<string?> RunOnceAsync(CancellationToken ct)
    {
        var sent = 0;
        var now = _clock.GetUtcNow();
        foreach (var uid in _state.Users)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var prefs = _settings.Read(uid);
                if (!prefs.ReminderOn) continue;

                using var scope = _scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                if (!int.TryParse(uid, out var id)) continue;
                var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
                if (user is null) continue;

                if (DueDay(now, user.TimeZone, prefs.DayStartsAt, prefs.ReminderTime, prefs.ReminderSentFor) is not { } day) continue;

                // Remember the day first: a failure to mail must not turn into a mail every five minutes.
                _settings.Write(uid, prefs with { ReminderSentFor = JournalClock.Format(day) });

                var entry = _state.PathFor(uid, JournalPaths.IdFor(day)) is { } path && _state.TryGet(uid, path, out var n) ? n : null;
                if (entry is not null && JournalService.Counts(entry)) continue; // already written today

                _email.NotifyInBackground(user, NotificationCatalog.JournalReminder,
                    "A quiet minute for today’s page?",
                    "Today’s page in your journal is still blank. Open Papyra whenever you have a moment.");
                sent++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Journal reminder skipped for user {User}", uid);
            }
        }
        return sent == 0 ? null : $"{sent} reminder{(sent == 1 ? "" : "s")} sent";
    }
}
