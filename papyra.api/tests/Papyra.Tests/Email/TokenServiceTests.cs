using Papyra.Api.Services;

namespace Papyra.Tests.Email;

// ── TokenServiceTests ─────────────────────────────────────────────────────────
// Validates token generation, hashing, expiry checks, and single-use semantics.

public sealed class TokenServiceTests
{
    // ── Generation ────────────────────────────────────────────────────────────

    [Fact]
    public void Generate_ProducesNonEmptyToken()
    {
        var (token, hash, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.NotEmpty(token);
        Assert.NotEmpty(hash);
        Assert.True(expiry > DateTime.UtcNow.Ticks);
    }

    [Fact]
    public void Generate_TokensAreUnique()
    {
        var tokens = Enumerable.Range(0, 20)
            .Select(_ => TokenService.Generate(TimeSpan.FromHours(1)).token)
            .ToList();
        Assert.Equal(tokens.Distinct().Count(), tokens.Count);
    }

    [Fact]
    public void Generate_HashDiffersFromToken()
    {
        var (token, hash, _) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.NotEqual(token, hash);
    }

    // ── Validation ────────────────────────────────────────────────────────────

    [Fact]
    public void IsValid_ReturnsTrueForValidToken()
    {
        var (token, hash, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.True(TokenService.IsValid(token, hash, expiry));
    }

    [Fact]
    public void IsValid_ReturnsFalseForWrongToken()
    {
        var (_, hash, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.False(TokenService.IsValid("wrong-token", hash, expiry));
    }

    [Fact]
    public void IsValid_ReturnsFalseForExpiredToken()
    {
        var (token, hash, _) = TokenService.Generate(TimeSpan.FromSeconds(-1)); // already expired
        var pastExpiry = DateTime.UtcNow.AddSeconds(-2).Ticks;
        Assert.False(TokenService.IsValid(token, hash, pastExpiry));
    }

    [Fact]
    public void IsValid_ReturnsFalseForNullHash()
    {
        var (token, _, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.False(TokenService.IsValid(token, null, expiry));
    }

    [Fact]
    public void IsValid_ReturnsFalseForEmptyToken()
    {
        var (_, hash, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.False(TokenService.IsValid(string.Empty, hash, expiry));
    }

    // ── Lifetime constants ────────────────────────────────────────────────────

    [Fact]
    public void EmailVerificationLifetime_Is24Hours()
    {
        Assert.Equal(TimeSpan.FromHours(24), TokenService.EmailVerificationLifetime);
    }

    [Fact]
    public void PasswordResetLifetime_Is1Hour()
    {
        Assert.Equal(TimeSpan.FromHours(1), TokenService.PasswordResetLifetime);
    }

    // ── Single-use semantics ──────────────────────────────────────────────────
    // Simulate clearing the token after use — subsequent calls must return false.

    [Fact]
    public void IsValid_ReturnsFalseAfterTokenCleared()
    {
        var (token, hash, expiry) = TokenService.Generate(TimeSpan.FromHours(1));
        Assert.True(TokenService.IsValid(token, hash, expiry));

        // "Consume" the token by nulling the hash (as done in AuthEndpoints)
        string? clearedHash = null;
        Assert.False(TokenService.IsValid(token, clearedHash, expiry));
    }
}
