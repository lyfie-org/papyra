using Microsoft.Extensions.Caching.Memory;
using Papyra.Api.Security;

namespace Papyra.Tests;

// The pure halves of the P8 hardening pass: what a password has to clear, how
// many guesses one account tolerates, and what the shipped CSP actually says.
public sealed class PasswordPolicyTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("short")]        // 5
    [InlineData("hunter2")]      // 7 — one under the floor
    public void Validate_RejectsWhatIsTooShortOrEmpty(string? password)
        => Assert.NotNull(PasswordPolicy.Validate(password));

    [Theory]
    [InlineData("hunter2!")]                     // exactly 8
    [InlineData("a longer passphrase entirely")] // length, not composition
    public void Validate_AcceptsAPasswordThatClearsTheFloor(string password)
        => Assert.Null(PasswordPolicy.Validate(password));

    [Fact]
    public void Validate_RejectsPastBCryptsLimitRatherThanTruncatingSilently()
    {
        // BCrypt only hashes the first 72 bytes; anything beyond it would be
        // ignored without the caller ever being told.
        Assert.Null(PasswordPolicy.Validate(new string('x', PasswordPolicy.MaxBytes)));
        Assert.NotNull(PasswordPolicy.Validate(new string('x', PasswordPolicy.MaxBytes + 1)));
    }

    [Fact]
    public void Validate_CountsBytesNotCharactersAtTheCeiling()
    {
        // 40 emoji are 40 characters but 160 UTF-8 bytes — over the limit BCrypt
        // actually enforces, so a character-based check would let it through.
        Assert.NotNull(PasswordPolicy.Validate(string.Concat(Enumerable.Repeat("😀", 40))));
    }

    [Fact]
    public void Validate_NeverEchoesThePasswordBack()
    {
        const string secret = "hunter";
        Assert.DoesNotContain(secret, PasswordPolicy.Validate(secret));
    }
}

public sealed class LoginThrottleTests
{
    private static LoginThrottle New() => new(new MemoryCache(new MemoryCacheOptions()));

    [Fact]
    public void AnAccountIsOpenUntilItSpendsItsBudget()
    {
        var throttle = New();
        Assert.False(throttle.IsLockedOut("bea"));

        for (var i = 0; i < LoginThrottle.MaxFailures - 1; i++) throttle.RecordFailure("bea");
        Assert.False(throttle.IsLockedOut("bea"));   // still one guess left

        throttle.RecordFailure("bea");
        Assert.True(throttle.IsLockedOut("bea"));
    }

    [Fact]
    public void ASuccessfulLoginClearsTheHistory()
    {
        var throttle = New();
        for (var i = 0; i < LoginThrottle.MaxFailures; i++) throttle.RecordFailure("bea");
        Assert.True(throttle.IsLockedOut("bea"));

        throttle.Reset("bea");
        Assert.False(throttle.IsLockedOut("bea"));
    }

    [Fact]
    public void LockoutIsPerAccount_NotGlobal()
    {
        var throttle = New();
        for (var i = 0; i < LoginThrottle.MaxFailures; i++) throttle.RecordFailure("bea");

        Assert.True(throttle.IsLockedOut("bea"));
        Assert.False(throttle.IsLockedOut("cal"));   // one account's siege is not everyone's
    }

    [Fact]
    public void TheAccountKeyIsCaseAndWhitespaceInsensitive()
    {
        // Login looks the user up case-sensitively after trimming, so the throttle
        // must not be dodgeable by varying the case of the same handle.
        var throttle = New();
        for (var i = 0; i < LoginThrottle.MaxFailures; i++) throttle.RecordFailure("BEA");
        Assert.True(throttle.IsLockedOut("  bea  "));
    }

    [Fact]
    public void AMissingUsernameIsIgnoredRatherThanTracked()
    {
        var throttle = New();
        throttle.RecordFailure(null);
        throttle.RecordFailure("   ");
        Assert.False(throttle.IsLockedOut(null));
    }
}

public sealed class SecurityHeadersTests
{
    [Fact]
    public void InlineScriptHashes_CoversAnInlineScriptButNotASourcedOne()
    {
        const string html = """
            <script src="/assets/main.js"></script>
            <script>document.documentElement.setAttribute('data-theme','dark');</script>
            """;

        var hashes = SecurityHeaders.InlineScriptHashes(html);
        var hash = Assert.Single(hashes);
        Assert.StartsWith("'sha256-", hash);
        Assert.EndsWith("'", hash);
    }

    [Fact]
    public void InlineScriptHashes_ChangesWhenTheScriptDoes()
    {
        var before = SecurityHeaders.InlineScriptHashes("<script>var a=1;</script>");
        var after = SecurityHeaders.InlineScriptHashes("<script>var a=2;</script>");
        Assert.NotEqual(before[0], after[0]);
    }

    [Theory]
    [InlineData("")]
    [InlineData("<html><body>no scripts here</body></html>")]
    [InlineData("<script src=\"/only-external.js\"></script>")]
    public void InlineScriptHashes_IsEmptyWhenThereIsNothingToHash(string html)
        => Assert.Empty(SecurityHeaders.InlineScriptHashes(html));

    [Fact]
    public void AppPolicy_LocksDownTheDirectivesThatCarryXss()
    {
        var csp = SecurityHeaders.AppPolicy([]);

        Assert.Contains("script-src 'self'", csp);
        Assert.Contains("object-src 'none'", csp);
        Assert.Contains("base-uri 'self'", csp);
        Assert.Contains("frame-ancestors 'none'", csp);
        // The one that would undo script-src entirely.
        Assert.DoesNotContain("script-src 'self' 'unsafe-inline'", csp);
    }

    [Fact]
    public void AppPolicy_AdmitsTheShippedInlineScriptByHash()
    {
        var hashes = SecurityHeaders.InlineScriptHashes("<script>var theme='dark';</script>");
        var csp = SecurityHeaders.AppPolicy(hashes);
        Assert.Contains(hashes[0], csp);
    }

    [Fact]
    public void AppPolicy_StillAllowsTheFeaturesPapyraActuallyShips()
    {
        var csp = SecurityHeaders.AppPolicy([]);

        Assert.Contains("https://fonts.googleapis.com", csp);   // Marcellus/Sora/Roboto Mono
        Assert.Contains("https://fonts.gstatic.com", csp);
        Assert.Contains("blob:", csp);                          // local media before upload
        Assert.Contains("ws:", csp);                            // SignalR — not covered by 'self'
        Assert.Contains("frame-src https:", csp);               // ![[youtube:…]] / ![[iframe:…]]
    }

    [Fact]
    public void DocsPolicy_RelaxesScriptsOnlyForTheDeveloperPortal()
    {
        var docs = SecurityHeaders.DocsPolicy();
        // Scalar bootstraps from an inline module script it regenerates on every
        // upgrade, so a hash there would break the portal on a dependency bump.
        Assert.Contains("script-src 'self' 'unsafe-inline'", docs);
        // The relaxation must not extend to the app's own policy.
        Assert.DoesNotContain("'unsafe-inline'", SecurityHeaders.AppPolicy([]).Split("style-src")[0]);
        Assert.Contains("frame-ancestors 'none'", docs);
    }
}
