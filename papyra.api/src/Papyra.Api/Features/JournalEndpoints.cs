using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Collab;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

public sealed record JournalAppend(string? Text, string? Heading);

public sealed record JournalPrefsWrite(
    int? DayStartsAt, bool? LockNewEntries, bool? PromptsOn, bool? HideStreak,
    bool? ReminderOn, string? ReminderTime, string? DefaultTemplate, bool? ClearDefaultTemplate);

public sealed record JournalTemplateWrite(string? Body);

/// <summary>
/// <c>/api/journal</c> — the journal's own API, used by the app and by scripts and
/// agents on a journal-scoped key (see <see cref="ApiKeyScopes"/>). One entry per
/// calendar day, addressed by <c>yyyy-MM-dd</c>; the entry is created by its first
/// real write. What a key may do is deliberately narrower than the person: it can
/// read and write today and the past, and append — it cannot delete, archive, lock,
/// change settings, restore history, or touch a locked entry at all.
/// </summary>
public static class JournalEndpoints
{
    /// <summary>The widest range one listing may cover (three years of daily entries).</summary>
    public const int MaxRangeDays = 1100;

    private sealed record Me(string Uid, bool IsKey, JournalActor Actor, string? TimeZone, bool PinSet);

    public static void MapJournal(this WebApplication app)
    {
        var g = app.MapGroup("/api/journal").RequireAuthorization().WithTags("Journal");

        g.MapGet("/today", Today).WithSummary("Today's page")
            .WithDescription("The journal day for this account (its time zone and day-start hour), its entry if there is one, and the streak. The server decides what \"today\" is.");
        g.MapGet("/", List).WithSummary("Entries in a date range")
            .WithDescription("Summaries (date, mood, tags, words, media, lock) for ?from=&to= (yyyy-MM-dd, at most ~3 years). Defaults to the current month.");
        g.MapGet("/stats", Stats).WithSummary("Streak and totals");
        g.MapGet("/on-this-day", OnThisDay).WithSummary("Earlier years' entries for this day");
        g.MapGet("/settings", GetSettings).WithSummary("Journal preferences");
        g.MapPut("/settings", PutSettings).WithSummary("Change journal preferences");
        g.MapGet("/templates", GetTemplates).WithSummary("The pages a day can start from");
        g.MapPut("/templates/{name}", PutTemplate).WithSummary("Save a template")
            .WithDescription("The person only. Markdown with {{date}}, {{weekday}} and {{streak}}; at most 20 templates of 20 KB.");
        g.MapDelete("/templates/{name}", DeleteTemplate).WithSummary("Remove a template");
        g.MapGet("/bin", Bin).WithSummary("Archived, trashed or locked days")
            .WithDescription("The person only. ?state=archived (default), trashed or locked, newest day first; a trashed day says when it went. Locked days carry no words. ?state=locked is what the Vault page lists: every locked day that isn't in the Trash.");
        g.MapPost("/lock-all", LockAll).WithSummary("Lock every entry")
            .WithDescription("The person only. Seals each unlocked, untrashed entry with the vault cipher; needs a vault PIN. Answers { locked }.");
        g.MapGet("/{date}", GetEntry).WithSummary("One day's entry")
            .WithDescription("The entry with an ETag naming its body. A day with no entry answers 200 { exists: false }. A locked entry answers metadata only.");
        g.MapPut("/{date}", PutEntry).WithSummary("Write one day's entry")
            .WithDescription("Absent fields keep what the entry has. Send the ETag back as If-Match: 412 stale when the entry moved on. An empty body with no mood on a missing day writes nothing. Future days are refused (422).");
        g.MapPost("/{date}/carry-over", CarryOver).WithSummary("Carry unticked items forward")
            .WithDescription("Copies the unticked checklist items of the latest earlier day into this one, skipping any already there. The earlier day is untouched.");
        g.MapPost("/{date}/append", Append).WithSummary("Append to a day")
            .WithDescription("Atomically adds text to the end of the day (or to a heading's section). The verb for \"log this to today\".");
    }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    private static async Task<Me> WhoAsync(ClaimsPrincipal user, AppDbContext db, CancellationToken ct)
    {
        var uid = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
        var id = int.Parse(uid);
        var row = await db.Users.Where(u => u.Id == id)
            .Select(u => new { u.TimeZone, Pin = u.VaultPinHash }).FirstOrDefaultAsync(ct);
        var isKey = user.Identity?.AuthenticationType == "ApiKey";
        var actor = isKey
            ? new JournalActor(true, -(int.TryParse(user.FindFirstValue(LiveAgentEdits.KeyIdClaim), out var k) ? k : 0),
                user.FindFirstValue(LiveAgentEdits.KeyNameClaim) ?? "API key")
            : JournalActor.Owner;
        return new Me(uid, isKey, actor, row?.TimeZone, !string.IsNullOrEmpty(row?.Pin));
    }

    private static bool UnlockedNow(HttpContext http, Me me) =>
        !me.IsKey && http.RequestServices.GetRequiredService<UnlockTokenStore>()
            .IsValid(http.Request.Headers["X-Unlock-Token"].ToString(), me.Uid);

    private static IResult BadDate() => Results.Json(
        new { error = "Dates look like 2026-10-25.", code = "invalid_date" }, statusCode: StatusCodes.Status400BadRequest);

    private static IResult LockedForKeys() => Results.Json(
        new { error = "This entry is locked.", code = "locked" }, statusCode: StatusCodes.Status423Locked);

    private static IResult KeyForbidden() => Results.Json(
        new { error = "A key can't do that. Use the app.", code = "key_forbidden" }, statusCode: StatusCodes.Status403Forbidden);

    private static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);

    private static object Dto(DateOnly day, Note? n, DateOnly today, bool revealBody)
    {
        var date = JournalClock.Format(day);
        var id = JournalPaths.IdFor(day);
        if (n is null)
            return new
            {
                date, id, exists = false, future = day > today, today = JournalClock.Format(today),
                body = string.Empty, mood = (int?)null, tags = Array.Empty<string>(), archived = false,
                locked = false, trashed = false, words = 0, updated = (DateTime?)null,
            };
        return new
        {
            date, id, exists = true, future = false, today = JournalClock.Format(today),
            body = n.Secure && !revealBody ? string.Empty : n.Body,
            mood = JournalService.MoodOf(n), tags = n.Tags, archived = n.Archived,
            locked = n.Secure, trashed = n.Trashed, words = JournalService.WordsOf(n), updated = (DateTime?)Utc(n.Updated),
        };
    }

    private static IResult Respond(HttpContext http, DateOnly day, Note? n, DateOnly today, bool revealBody, int status = 200)
    {
        if (n is not null && (!n.Secure || revealBody)) http.Response.Headers.ETag = JournalService.Etag(n.Body);
        return Results.Json(Dto(day, n, today, revealBody), statusCode: status);
    }

    private static IResult Refuse(JournalResult r) => r.Status switch
    {
        JournalStatus.Stale => LiveAgentEdits.Stale(r.CurrentBody ?? string.Empty),
        JournalStatus.Future => Results.Json(new { error = r.Error, code = "future_date" }, statusCode: StatusCodes.Status422UnprocessableEntity),
        JournalStatus.Invalid => Results.Json(new { error = r.Error, code = "invalid" }, statusCode: StatusCodes.Status422UnprocessableEntity),
        JournalStatus.PinNotSet => Results.Json(new { error = r.Error, code = "pin_not_set" }, statusCode: StatusCodes.Status409Conflict),
        JournalStatus.UnlockRequired => Results.Json(new { error = r.Error, code = "locked" }, statusCode: StatusCodes.Status401Unauthorized),
        JournalStatus.Trashed => Results.Json(new { error = r.Error, code = "trashed" }, statusCode: StatusCodes.Status409Conflict),
        _ => Results.Problem(),
    };

    // ── Reads ────────────────────────────────────────────────────────────────

    private static async Task<IResult> Today(
        ClaimsPrincipal user, HttpContext http, AppDbContext db, JournalService journal, JournalSettings settings, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        var today = journal.Today(me.Uid, me.TimeZone);
        var entry = journal.Get(me.Uid, today);
        if (me.IsKey && entry?.Secure == true) return LockedForKeys();
        if (entry is not null && (!entry.Secure || UnlockedNow(http, me))) http.Response.Headers.ETag = JournalService.Etag(entry.Body);
        return Results.Ok(new
        {
            date = JournalClock.Format(today),
            entry = Dto(today, entry, today, entry is not null && UnlockedNow(http, me)),
            stats = journal.Stats(me.Uid, today),
            settings = settings.Read(me.Uid),
            pinSet = me.PinSet,
        });
    }

    private static async Task<IResult> List(
        string? from, string? to, ClaimsPrincipal user, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        var today = journal.Today(me.Uid, me.TimeZone);
        DateOnly start, end;
        if (from is null && to is null)
        {
            start = new DateOnly(today.Year, today.Month, 1);
            end = start.AddMonths(1).AddDays(-1);
        }
        else
        {
            if (!JournalPaths.TryParseDate(from ?? to, out start) || !JournalPaths.TryParseDate(to ?? from, out end)) return BadDate();
            if (end < start) return BadDate();
        }
        if (end.DayNumber - start.DayNumber > MaxRangeDays)
            return Results.Json(new { error = $"Ask for at most {MaxRangeDays} days at a time.", code = "range_too_large" },
                statusCode: StatusCodes.Status422UnprocessableEntity);

        var all = journal.Summaries(me.Uid, start, end);
        // A key never learns about a locked day beyond the fact that it is there.
        var entries = me.IsKey ? all.Select(s => s.Locked ? s with { Tags = [], Cover = null, Excerpt = null } : s).ToList() : all.ToList();
        return Results.Ok(new { from = JournalClock.Format(start), to = JournalClock.Format(end), today = JournalClock.Format(today), entries });
    }

    private static async Task<IResult> Stats(ClaimsPrincipal user, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        return Results.Ok(journal.Stats(me.Uid, journal.Today(me.Uid, me.TimeZone)));
    }

    private static async Task<IResult> OnThisDay(
        string? date, ClaimsPrincipal user, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        var day = journal.Today(me.Uid, me.TimeZone);
        if (date is not null && !JournalPaths.TryParseDate(date, out day)) return BadDate();
        var entries = journal.OnThisDay(me.Uid, day);
        return Results.Ok(new { date = JournalClock.Format(day), entries });
    }

    private static async Task<IResult> GetEntry(
        string date, ClaimsPrincipal user, HttpContext http, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        if (!JournalPaths.TryParseDate(date, out var day)) return BadDate();
        var me = await WhoAsync(user, db, ct);
        var today = journal.Today(me.Uid, me.TimeZone);
        var entry = journal.Get(me.Uid, day);
        if (me.IsKey && entry?.Secure == true) return LockedForKeys();
        return Respond(http, day, entry, today, revealBody: entry is not null && UnlockedNow(http, me));
    }

    // ── Settings (the person only) ───────────────────────────────────────────

    private static async Task<IResult> GetSettings(ClaimsPrincipal user, AppDbContext db, JournalSettings settings, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        return Results.Ok(new { settings = settings.Read(me.Uid), pinSet = me.PinSet });
    }

    private static async Task<IResult> PutSettings(
        JournalPrefsWrite body, ClaimsPrincipal user, AppDbContext db, JournalSettings settings, JournalTemplates templates, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        var cur = settings.Read(me.Uid);
        // The default has to be a template that exists, stored by its plain name.
        string? defaultTemplate = null;
        if (!string.IsNullOrWhiteSpace(body.DefaultTemplate))
        {
            defaultTemplate = JournalTemplates.Clean(body.DefaultTemplate);
            if (defaultTemplate is null || !templates.List(me.Uid).Any(t => t.Name == defaultTemplate))
                return Results.Json(new { error = "Pick one of your templates.", code = "invalid" }, statusCode: 422);
        }
        if (body.DayStartsAt is < 0 or > JournalClock.MaxDayStartsAt)
            return Results.Json(new { error = "The day can start between midnight and 5 a.m.", code = "invalid" }, statusCode: 422);
        if (body.LockNewEntries == true && !me.PinSet)
            return Results.Json(new { error = "Set a vault PIN before locking new entries.", code = "pin_not_set" }, statusCode: StatusCodes.Status409Conflict);
        if (body.ReminderTime is not null && body.ReminderTime.Length > 0
            && !TimeOnly.TryParseExact(body.ReminderTime, "HH:mm", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out _))
            return Results.Json(new { error = "Reminder time looks like 21:30.", code = "invalid" }, statusCode: 422);

        var next = cur with
        {
            DayStartsAt = body.DayStartsAt ?? cur.DayStartsAt,
            LockNewEntries = body.LockNewEntries ?? cur.LockNewEntries,
            PromptsOn = body.PromptsOn ?? cur.PromptsOn,
            HideStreak = body.HideStreak ?? cur.HideStreak,
            ReminderOn = body.ReminderOn ?? cur.ReminderOn,
            ReminderTime = body.ReminderTime is null ? cur.ReminderTime : (body.ReminderTime.Length == 0 ? null : body.ReminderTime),
            DefaultTemplate = body.ClearDefaultTemplate == true ? null : defaultTemplate ?? cur.DefaultTemplate,
        };
        return Results.Ok(new { settings = settings.Write(me.Uid, next), pinSet = me.PinSet });
    }

    private static async Task<IResult> GetTemplates(
        ClaimsPrincipal user, AppDbContext db, JournalTemplates templates, JournalSettings settings, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        return Results.Ok(new { templates = templates.List(me.Uid), defaultTemplate = settings.Read(me.Uid).DefaultTemplate });
    }

    private static async Task<IResult> PutTemplate(
        string name, JournalTemplateWrite body, ClaimsPrincipal user, AppDbContext db, JournalTemplates templates, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        return templates.Save(me.Uid, name, body.Body, out var stored) switch
        {
            JournalTemplates.SaveStatus.Ok => Results.Ok(new JournalTemplate(stored!, body.Body ?? string.Empty)),
            JournalTemplates.SaveStatus.BadName => Results.Json(
                new { error = "A template name uses letters, numbers, spaces, dots, dashes and underscores (60 at most).", code = "invalid_name" }, statusCode: 422),
            JournalTemplates.SaveStatus.TooLarge => Results.Json(
                new { error = "That template is too long.", code = "too_large" }, statusCode: StatusCodes.Status413PayloadTooLarge),
            _ => Results.Json(
                new { error = $"You can keep {JournalTemplates.MaxTemplates} templates. Remove one first.", code = "too_many" }, statusCode: StatusCodes.Status409Conflict),
        };
    }

    private static async Task<IResult> DeleteTemplate(
        string name, ClaimsPrincipal user, AppDbContext db, JournalTemplates templates, JournalSettings settings, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        if (!templates.Delete(me.Uid, name)) return Results.NotFound();
        var cur = settings.Read(me.Uid);
        if (string.Equals(cur.DefaultTemplate, JournalTemplates.Clean(name) + ".md", StringComparison.OrdinalIgnoreCase)
            || string.Equals(cur.DefaultTemplate, JournalTemplates.Clean(name), StringComparison.OrdinalIgnoreCase))
            settings.Write(me.Uid, cur with { DefaultTemplate = null });
        return Results.NoContent();
    }

    private static async Task<IResult> Bin(
        string? state, ClaimsPrincipal user, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        if (state is not (null or "archived" or "trashed" or "locked"))
            return Results.Json(new { error = "state is archived, trashed or locked.", code = "invalid" }, statusCode: 422);
        return Results.Ok(new { state = state ?? "archived", entries = journal.Bin(me.Uid, state ?? "archived") });
    }

    private static async Task<IResult> LockAll(
        ClaimsPrincipal user, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey) return KeyForbidden();
        var (refused, locked) = await journal.LockAllAsync(me.Uid, me.TimeZone, me.PinSet, ct);
        return refused is not null ? Refuse(refused) : Results.Ok(new { locked });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    private static async Task<IResult> PutEntry(
        string date, JournalWrite body, ClaimsPrincipal user, HttpContext http, AppDbContext db,
        JournalService journal, CancellationToken ct)
    {
        if (!JournalPaths.TryParseDate(date, out var day)) return BadDate();
        var me = await WhoAsync(user, db, ct);
        if (me.IsKey)
        {
            // A key reads and writes entries; archiving and locking are the person's.
            if (body.Archived is not null || body.Secure is not null) return KeyForbidden();
            if (journal.Get(me.Uid, day)?.Secure == true) return LockedForKeys();
        }
        body.BaseHash ??= LiveAgentEdits.IfMatch(http.Request);
        body.ForceSnapshot = string.Equals(http.Request.Headers[SnapshotService.ForceHeader], "force", StringComparison.OrdinalIgnoreCase);

        var result = await journal.WriteAsync(me.Uid, day, body, me.Actor, me.TimeZone, me.PinSet, UnlockedNow(http, me), ct);
        var today = journal.Today(me.Uid, me.TimeZone);
        return result.Status is JournalStatus.Ok or JournalStatus.NoOp
            ? Respond(http, day, result.Note, today, revealBody: result.Note is not null && (!result.Note.Secure || UnlockedNow(http, me)))
            : Refuse(result);
    }

    private static async Task<IResult> CarryOver(
        string date, ClaimsPrincipal user, HttpContext http, AppDbContext db, JournalService journal, CancellationToken ct)
    {
        if (!JournalPaths.TryParseDate(date, out var day)) return BadDate();
        var me = await WhoAsync(user, db, ct);
        var unlocked = UnlockedNow(http, me);
        if (journal.Get(me.Uid, day)?.Secure == true && !unlocked) return LockedForKeys();

        var (result, carried) = await journal.CarryOverAsync(me.Uid, day, me.Actor, me.TimeZone, me.PinSet, unlocked, ct);
        if (result.Status is not (JournalStatus.Ok or JournalStatus.NoOp)) return Refuse(result);
        var today = journal.Today(me.Uid, me.TimeZone);
        http.Response.Headers["X-Papyra-Carried"] = carried.ToString();
        return Respond(http, day, result.Note, today, revealBody: result.Note is not null && (!result.Note.Secure || unlocked));
    }

    private static async Task<IResult> Append(
        string date, JournalAppend body, ClaimsPrincipal user, HttpContext http, AppDbContext db,
        JournalService journal, CancellationToken ct)
    {
        if (!JournalPaths.TryParseDate(date, out var day)) return BadDate();
        if (string.IsNullOrWhiteSpace(body.Text))
            return Results.Json(new { error = "Send some text to append.", code = "invalid" }, statusCode: 422);
        var me = await WhoAsync(user, db, ct);
        var unlocked = UnlockedNow(http, me);
        if (journal.Get(me.Uid, day)?.Secure == true && !unlocked) return LockedForKeys();

        var result = await journal.AppendAsync(me.Uid, day, body.Text, body.Heading, me.Actor, me.TimeZone, me.PinSet, unlocked, ct);
        var today = journal.Today(me.Uid, me.TimeZone);
        return result.Status is JournalStatus.Ok or JournalStatus.NoOp
            ? Respond(http, day, result.Note, today, revealBody: result.Note is not null && (!result.Note.Secure || unlocked))
            : Refuse(result);
    }
}
