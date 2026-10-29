using System.Security.Cryptography;
using System.Text;

namespace Papyra.Api.Storage;

/// <summary>
/// WHEN the daily update check runs (see <c>UpdateCheck.cs</c> for what it sends).
///
/// Every install asks once per UTC day, at a time of day of its own: worked out from its random id, so it
/// is fixed for that install, needs nothing stored, and spreads the world's check-ins evenly across the day
/// instead of piling up whenever a release lands. Nobody asks between 02:30 and 03:30 UTC (08:00–09:00 IST):
/// that is the quiet hour in which the website is rebuilt from the day's numbers, so the numbers don't move
/// underneath it.
/// </summary>
public static class UpdateSchedule
{
    /// <summary>The quiet hour, UTC: 02:30–03:30 (08:00–09:00 IST). Keep in step with the cron in .github/workflows/site.yml.</summary>
    public static readonly TimeSpan QuietStart = new(2, 30, 0);
    public static readonly TimeSpan QuietEnd = new(3, 30, 0);

    private static readonly TimeSpan Day = TimeSpan.FromDays(1);
    private static readonly int OpenSeconds = (int)(Day - (QuietEnd - QuietStart)).TotalSeconds;

    /// <summary>
    /// This install's time of day (UTC): the same every day, anywhere outside the quiet hour. The id's hash
    /// picks a second among the 23 open hours, counted on from the end of the quiet hour.
    /// </summary>
    public static TimeSpan Slot(string instanceId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(instanceId));
        var seconds = (long)(BitConverter.ToUInt32(hash, 0) % (uint)OpenSeconds);
        var timeOfDay = (QuietEnd + TimeSpan.FromSeconds(seconds)).TotalSeconds % Day.TotalSeconds;
        return TimeSpan.FromSeconds(timeOfDay);
    }

    public static bool InQuietHour(DateTimeOffset at)
    {
        var t = at.UtcDateTime.TimeOfDay;
        return t >= QuietStart && t < QuietEnd;
    }

    /// <summary>
    /// When to ask next.
    /// <list type="bullet">
    /// <item>A first check (never made one) is due at once, so a new install appears straight away.</item>
    /// <item>After a check, the next is due at this install's time of day on the following UTC day. A restart
    /// doesn't ask again: the last check is remembered.</item>
    /// <item>If that time has passed (the server was off), it is due now.</item>
    /// <item><paramref name="notBefore"/> holds it back (a moment after boot; a wait after a failure).</item>
    /// <item>Whatever the result, it never lands in the quiet hour: it moves to the end of it, plus up to
    /// <paramref name="jitterSeconds"/> so everyone doesn't arrive at the same second.</item>
    /// </list>
    /// </summary>
    public static DateTimeOffset Next(DateTimeOffset now, DateTimeOffset? lastCheck, string instanceId,
        DateTimeOffset notBefore, Func<int> jitterSeconds)
    {
        var due = now;
        if (lastCheck is { } last)
        {
            var nextDay = new DateTimeOffset(last.UtcDateTime.Date, TimeSpan.Zero).AddDays(1);
            due = nextDay + Slot(instanceId);
        }
        if (due < notBefore) due = notBefore;
        if (due < now) due = now;

        if (InQuietHour(due))
        {
            var midnight = new DateTimeOffset(due.UtcDateTime.Date, TimeSpan.Zero);
            due = midnight + QuietEnd + TimeSpan.FromSeconds(jitterSeconds());
        }
        return due;
    }
}
