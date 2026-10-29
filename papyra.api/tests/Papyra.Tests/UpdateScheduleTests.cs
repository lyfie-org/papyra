using Papyra.Api.Storage;

namespace Papyra.Tests;

// When the daily update check runs: a time of day of each install's own, never in the quiet hour
// (02:30–03:30 UTC = 08:00–09:00 IST, when the site is rebuilt), and not again on a restart.
public sealed class UpdateScheduleTests
{
    private static DateTimeOffset Utc(int day, int h, int m = 0, int s = 0) => new(2026, 10, day, h, m, s, TimeSpan.Zero);
    private static readonly Func<int> NoJitter = () => 0;
    private const string Id = "2d1f0c2e-3b4a-4c5d-8e6f-0a1b2c3d4e5f";

    [Fact]
    public void AnInstallsSlot_IsFixed_AndNeverInTheQuietHour()
    {
        Assert.Equal(UpdateSchedule.Slot(Id), UpdateSchedule.Slot(Id));
        for (var i = 0; i < 20_000; i++)
        {
            var slot = UpdateSchedule.Slot(Guid.NewGuid().ToString());
            Assert.InRange(slot, TimeSpan.Zero, TimeSpan.FromDays(1) - TimeSpan.FromTicks(1));
            Assert.False(slot >= UpdateSchedule.QuietStart && slot < UpdateSchedule.QuietEnd, $"slot {slot} is in the quiet hour");
        }
    }

    [Fact]
    public void TheSlotsSpreadAcrossTheWholeDay()
    {
        var perHour = new int[24];
        for (var i = 0; i < 24_000; i++) perHour[UpdateSchedule.Slot(Guid.NewGuid().ToString()).Hours]++;
        // 24,000 installs: about 1,000 an hour, and the quiet hour (and half of its neighbour) holds only the rest.
        for (var h = 0; h < 24; h++)
        {
            if (h == 3) continue;                       // 03:00–03:30 is quiet, 03:30–04:00 open: half an hour
            if (h == 2) continue;                       // 02:00–02:30 open, 02:30–03:00 quiet: half an hour
            Assert.InRange(perHour[h], 800, 1_200);
        }
        Assert.InRange(perHour[2], 350, 650);
        Assert.InRange(perHour[3], 350, 650);
    }

    [Fact]
    public void AFirstEverCheck_IsDueAtOnce_AfterBoot()
    {
        var now = Utc(29, 10);
        var due = UpdateSchedule.Next(now, null, Id, notBefore: now.AddSeconds(45), NoJitter);
        Assert.Equal(now.AddSeconds(45), due);
    }

    [Fact]
    public void AfterACheck_TheNextIsThisInstallsSlotOnTheFollowingDay()
    {
        var slot = UpdateSchedule.Slot(Id);
        var last = Utc(29, 10);
        var due = UpdateSchedule.Next(Utc(29, 10, 5), last, Id, notBefore: Utc(29, 10), NoJitter);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 0, 0, 0, TimeSpan.Zero) + slot, due);
    }

    [Fact]
    public void ARestartDoesNotAskAgain()
    {
        // Checked this morning, restarted this afternoon: still tomorrow's slot, not "45 seconds after boot".
        var due = UpdateSchedule.Next(Utc(29, 15), Utc(29, 9), Id, notBefore: Utc(29, 15).AddSeconds(45), NoJitter);
        Assert.True(due > Utc(29, 23, 59, 59));
        Assert.Equal(30, due.UtcDateTime.Day);
    }

    [Fact]
    public void AServerThatWasOff_IsDueNow()
    {
        var now = Utc(29, 12);
        var due = UpdateSchedule.Next(now, Utc(20, 9), Id, notBefore: now.AddSeconds(45), NoJitter);
        Assert.Equal(now.AddSeconds(45), due);
    }

    [Fact]
    public void AFailedCheck_WaitsBeforeTryingAgain()
    {
        var now = Utc(29, 12);
        var due = UpdateSchedule.Next(now, Utc(28, 9), Id, notBefore: now.AddHours(3), NoJitter);
        Assert.Equal(now.AddHours(3), due);
    }

    [Theory]
    [InlineData(29, 2, 30)]    // the first second of the quiet hour
    [InlineData(29, 2, 59)]
    [InlineData(29, 3, 29)]    // the last minute of it
    public void NothingIsEverDueInTheQuietHour_ItWaitsForTheEnd(int day, int h, int m)
    {
        var due = UpdateSchedule.Next(Utc(day, h, m), null, Id, notBefore: Utc(day, h, m), NoJitter);
        Assert.Equal(Utc(day, 3, 30), due);

        // With a little jitter, so the whole world doesn't arrive at 03:30:00.
        var jittered = UpdateSchedule.Next(Utc(day, h, m), null, Id, notBefore: Utc(day, h, m), () => 420);
        Assert.Equal(Utc(day, 3, 37), jittered);
    }

    [Fact]
    public void TheQuietHourIsEdgeExact_AndNoScheduleLandsInIt()
    {
        Assert.False(UpdateSchedule.InQuietHour(Utc(29, 2, 29, 59)));
        Assert.True(UpdateSchedule.InQuietHour(Utc(29, 2, 30)));
        Assert.True(UpdateSchedule.InQuietHour(Utc(29, 3, 29, 59)));
        Assert.False(UpdateSchedule.InQuietHour(Utc(29, 3, 30)));

        var random = new Random(7);
        for (var i = 0; i < 20_000; i++)
        {
            var now = Utc(29, 0).AddSeconds(random.Next(0, 3 * 86_400));
            var last = random.Next(3) == 0 ? (DateTimeOffset?)null : now.AddSeconds(-random.Next(0, 5 * 86_400));
            var id = Guid.NewGuid().ToString();
            var due = UpdateSchedule.Next(now, last, id, notBefore: now.AddSeconds(random.Next(0, 4 * 3600)), () => random.Next(0, 600));
            Assert.False(UpdateSchedule.InQuietHour(due), $"{due:u} is inside the quiet hour");
            Assert.True(due >= now);
        }
    }
}
