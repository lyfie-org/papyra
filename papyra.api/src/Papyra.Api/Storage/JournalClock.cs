using System.Globalization;

namespace Papyra.Api.Storage;

/// <summary>
/// What day it is for a journal. A day belongs to the person's own time zone and
/// — for a night owl — ends at <c>dayStartsAt</c> hours past midnight rather than
/// at midnight itself, so a line written at 01:30 still lands on the day that
/// felt like "today". The server answers this (<c>GET /api/journal/today</c>);
/// the browser never decides it, so a laptop with a wrong clock can't write into
/// a future page.
/// </summary>
public static class JournalClock
{
    public const int MaxDayStartsAt = 5;

    /// <summary>The journal day of <paramref name="utcNow"/> in <paramref name="timeZoneId"/> (UTC when unknown).</summary>
    public static DateOnly Today(DateTimeOffset utcNow, string? timeZoneId, int dayStartsAt)
    {
        var local = TimeZoneInfo.ConvertTime(utcNow, ZoneOrUtc(timeZoneId));
        return DateOnly.FromDateTime(local.DateTime.AddHours(-Math.Clamp(dayStartsAt, 0, MaxDayStartsAt)));
    }

    public static DateOnly Today(TimeProvider clock, string? timeZoneId, int dayStartsAt) =>
        Today(clock.GetUtcNow(), timeZoneId, dayStartsAt);

    /// <summary>The instant a journal day ends in the person's zone (the next day's start).</summary>
    public static DateTimeOffset EndOfDay(DateOnly day, string? timeZoneId, int dayStartsAt)
    {
        var zone = ZoneOrUtc(timeZoneId);
        var next = day.AddDays(1).ToDateTime(TimeOnly.MinValue).AddHours(Math.Clamp(dayStartsAt, 0, MaxDayStartsAt));
        // Skip a daylight-saving gap rather than throw on a non-existent local time.
        if (zone.IsInvalidTime(next)) next = next.AddHours(1);
        return new DateTimeOffset(next, zone.GetUtcOffset(next));
    }

    public static TimeZoneInfo ZoneOrUtc(string? timeZoneId)
    {
        if (string.IsNullOrWhiteSpace(timeZoneId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(timeZoneId.Trim()); }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }

    public static string Format(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
