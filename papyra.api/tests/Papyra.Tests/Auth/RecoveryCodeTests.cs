using System.Text.RegularExpressions;
using Papyra.Api.Services;

namespace Papyra.Tests.Auth;

public sealed class RecoveryCodeTests
{
    // ── Format ────────────────────────────────────────────────────────────────

    [Fact]
    public void GenerateRecoveryCode_Format_IsXXXX_XXXX_XXXX()
    {
        var code = TotpService.GenerateRecoveryCode();
        Assert.Matches(@"^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$", code);
    }

    [Fact]
    public void GenerateRecoveryCode_Length_Is14()
    {
        Assert.Equal(14, TotpService.GenerateRecoveryCode().Length);
    }

    [Fact]
    public void GenerateRecoveryCode_Uniqueness_100Samples()
    {
        var svc    = new TotpService();
        var codes  = svc.GenerateRecoveryCodes(100);
        var unique = new HashSet<string>(codes);
        Assert.Equal(100, unique.Count);
    }

    // ── Hash / verify cycle ───────────────────────────────────────────────────

    [Fact]
    public void RecoveryCode_HashThenVerify_Succeeds()
    {
        var code = TotpService.GenerateRecoveryCode();
        var hash = BCrypt.Net.BCrypt.HashPassword(code, workFactor: 4);
        Assert.True(BCrypt.Net.BCrypt.Verify(code, hash));
    }

    [Fact]
    public void RecoveryCode_WrongCode_VerifyFails()
    {
        var code  = TotpService.GenerateRecoveryCode();
        var other = TotpService.GenerateRecoveryCode();
        var hash  = BCrypt.Net.BCrypt.HashPassword(code, workFactor: 4);
        Assert.False(BCrypt.Net.BCrypt.Verify(other, hash));
    }

    // ── Count ─────────────────────────────────────────────────────────────────

    [Fact]
    public void GenerateRecoveryCodes_DefaultCount_Is8()
    {
        var svc   = new TotpService();
        var codes = svc.GenerateRecoveryCodes();
        Assert.Equal(8, codes.Length);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(10)]
    public void GenerateRecoveryCodes_RespectsCount(int count)
    {
        var svc   = new TotpService();
        var codes = svc.GenerateRecoveryCodes(count);
        Assert.Equal(count, codes.Length);
    }
}
