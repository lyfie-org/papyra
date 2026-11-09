namespace Papyra.Api.Storage;

/// <summary>
/// WHEN the daily update check runs (see <c>UpdateCheck.cs</c> for what it asks and sends).
///
/// About once a day: a day after the last check that got an answer, plus a few random minutes so servers
/// that were started together don't all ask GitHub at the same second. A first check (none remembered) is due
/// a moment after boot. A restart doesn't ask again, because the last check is remembered. A check that got
/// no answer is tried again after an hour, then two, four and six.
/// </summary>
public static class UpdateSchedule
{
    public static readonly TimeSpan Interval = TimeSpan.FromHours(24);

    /// <summary>
    /// How long to wait before trying again after a check that got no answer: an hour, then two, four,
    /// and six at most, so a GitHub that is unreachable isn't asked every hour.
    /// </summary>
    public static TimeSpan RetryDelay(int failures) =>
        TimeSpan.FromHours(Math.Min(6, 1 << Math.Clamp(failures - 1, 0, 3)));

    /// <summary>
    /// When to ask next.
    /// <list type="bullet">
    /// <item>Never checked: due at once (held back by <paramref name="notBefore"/>, a moment after boot).</item>
    /// <item>Otherwise a day after <paramref name="lastCheck"/>, plus up to <paramref name="jitterSeconds"/>.</item>
    /// <item>If that time has passed (the server was off), it is due now.</item>
    /// <item><paramref name="notBefore"/> always holds it back (a moment after boot; a wait after a failure).</item>
    /// </list>
    /// </summary>
    public static DateTimeOffset Next(DateTimeOffset now, DateTimeOffset? lastCheck, DateTimeOffset notBefore, Func<int> jitterSeconds)
    {
        var due = lastCheck is { } last ? last + Interval + TimeSpan.FromSeconds(jitterSeconds()) : now;
        if (due < notBefore) due = notBefore;
        if (due < now) due = now;
        return due;
    }
}
