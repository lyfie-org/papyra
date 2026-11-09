using Papyra.Api.Storage;

namespace Papyra.Tests;

// When the daily update check runs: about a day after the last answer, a few random minutes apart from
// everyone else, not again on a restart, and a growing wait after a check that got no answer.
public sealed class UpdateScheduleTests
{
    private static DateTimeOffset Utc(int day, int h, int m = 0, int s = 0) => new(2026, 11, day, h, m, s, TimeSpan.Zero);
    private static readonly Func<int> NoJitter = () => 0;

    [Fact]
    public void ANewInstallAsksAMomentAfterBoot()
    {
        var now = Utc(5, 10);
        var due = UpdateSchedule.Next(now, null, notBefore: now.AddSeconds(45), NoJitter);
        Assert.Equal(now.AddSeconds(45), due);
    }

    [Fact]
    public void AfterAnAnswer_TheNextCheckIsADayLater()
    {
        var last = Utc(5, 9, 30);
        var due = UpdateSchedule.Next(Utc(5, 9, 31), last, notBefore: Utc(5, 9, 31), NoJitter);
        Assert.Equal(last.AddHours(24), due);
    }

    [Fact]
    public void ARestartDoesNotAskAgain()
    {
        // The server came back three hours later: the last answer is remembered, so nothing is due yet.
        var last = Utc(5, 9);
        var restartedAt = Utc(5, 12);
        var due = UpdateSchedule.Next(restartedAt, last, notBefore: restartedAt.AddSeconds(45), NoJitter);
        Assert.Equal(Utc(6, 9), due);
    }

    [Fact]
    public void AServerThatWasOffAsksAtOnce()
    {
        var now = Utc(20, 15);
        var due = UpdateSchedule.Next(now, Utc(5, 9), notBefore: now.AddSeconds(45), NoJitter);
        Assert.Equal(now.AddSeconds(45), due);                   // held back only by the moment after boot
    }

    [Fact]
    public void AWaitAfterAFailureHoldsTheCheckBack()
    {
        var now = Utc(5, 10);
        var due = UpdateSchedule.Next(now, Utc(4, 9), notBefore: now.AddHours(3), NoJitter);
        Assert.Equal(now.AddHours(3), due);
    }

    [Fact]
    public void ServersStartedTogetherDoNotAskTogether()
    {
        var last = Utc(5, 9);
        var early = UpdateSchedule.Next(Utc(5, 9, 1), last, Utc(5, 9, 1), () => 0);
        var late = UpdateSchedule.Next(Utc(5, 9, 1), last, Utc(5, 9, 1), () => 3599);
        Assert.Equal(TimeSpan.FromSeconds(3599), late - early);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(2, 2)]
    [InlineData(3, 4)]
    [InlineData(4, 6)]
    [InlineData(9, 6)]
    public void AfterANoAnswer_TheWaitGrowsToSixHours(int failures, int hours) =>
        Assert.Equal(TimeSpan.FromHours(hours), UpdateSchedule.RetryDelay(failures));
}
