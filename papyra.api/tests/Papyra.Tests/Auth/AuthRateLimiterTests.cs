using Papyra.Api.Services;

namespace Papyra.Tests.Auth;

public sealed class AuthRateLimiterTests
{
    [Fact]
    public void IsBlocked_NoFailures_ReturnsFalse()
    {
        var limiter = new AuthRateLimiter();
        Assert.False(limiter.IsBlocked("1.2.3.4"));
    }

    [Fact]
    public void IsBlocked_FourFailures_ReturnsFalse()
    {
        var limiter = new AuthRateLimiter();
        for (var i = 0; i < 4; i++) limiter.RecordFailure("1.2.3.4");
        Assert.False(limiter.IsBlocked("1.2.3.4"));
    }

    [Fact]
    public void IsBlocked_FiveFailures_ReturnsTrue()
    {
        var limiter = new AuthRateLimiter();
        for (var i = 0; i < 5; i++) limiter.RecordFailure("1.2.3.4");
        Assert.True(limiter.IsBlocked("1.2.3.4"));
    }

    [Fact]
    public void Reset_ClearsFailures()
    {
        var limiter = new AuthRateLimiter();
        for (var i = 0; i < 5; i++) limiter.RecordFailure("1.2.3.4");
        Assert.True(limiter.IsBlocked("1.2.3.4"));
        limiter.Reset("1.2.3.4");
        Assert.False(limiter.IsBlocked("1.2.3.4"));
    }

    [Fact]
    public void DifferentIps_IndependentCounters()
    {
        var limiter = new AuthRateLimiter();
        for (var i = 0; i < 5; i++) limiter.RecordFailure("10.0.0.1");
        Assert.True(limiter.IsBlocked("10.0.0.1"));
        Assert.False(limiter.IsBlocked("10.0.0.2"));
    }
}
