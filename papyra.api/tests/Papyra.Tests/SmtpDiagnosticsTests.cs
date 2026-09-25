using System.Net.Mail;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// The SMTP test email is where an admin finds out their mail setup is wrong, so
// its error has to say what to change. Pins the Gmail cases that fail most often.
public sealed class SmtpDiagnosticsTests
{
    private const string GmailAuthRequired =
        "The SMTP server requires a secure connection or the client was not authenticated. " +
        "The server response was: 5.7.0 Authentication Required. For more information, go to";

    [Fact]
    public void Precheck_GmailUsernameWithoutAt_SaysUseTheFullAddress()
    {
        var msg = SmtpDiagnostics.Precheck("smtp.gmail.com", 587, "papyra");
        Assert.NotNull(msg);
        Assert.Contains("full Gmail address", msg);
        Assert.Contains("papyra", msg);
    }

    [Theory]
    [InlineData("smtp.gmail.com", 587, "me@gmail.com")]
    [InlineData("SMTP.GMAIL.COM.", 587, "me@gmail.com")]
    [InlineData("mail.example.com", 587, "papyra")]   // non-Google: plain usernames are normal
    [InlineData("mail.example.com", 25, "")]         // unauthenticated relay
    public void Precheck_ValidSettings_Pass(string host, int port, string user)
        => Assert.Null(SmtpDiagnostics.Precheck(host, port, user));

    [Fact]
    public void Precheck_Gmail_RequiresALogin()
        => Assert.Contains("requires a login", SmtpDiagnostics.Precheck("smtp.gmail.com", 587, "  ")!);

    [Fact]
    public void Precheck_Port465_IsRefusedWithTheFix()
        => Assert.Contains("587", SmtpDiagnostics.Precheck("smtp.example.com", 465, "u")!);

    [Fact]
    public void Explain_GmailAuthFailure_PointsAtAppPasswords_AndKeepsTheServerText()
    {
        var msg = SmtpDiagnostics.Explain("smtp.gmail.com", 587, true, "me@gmail.com", new SmtpException(GmailAuthRequired));
        Assert.Contains("App Password", msg);
        Assert.Contains("5.7.0 Authentication Required", msg);
    }

    [Fact]
    public void Explain_TlsOff_SaysTurnItOn()
    {
        var msg = SmtpDiagnostics.Explain("smtp.gmail.com", 587, false, "me@gmail.com", new SmtpException(GmailAuthRequired));
        Assert.Contains("Use TLS/SSL", msg);
    }

    [Fact]
    public void Explain_OtherHostAuthFailure_IsGeneric()
    {
        var msg = SmtpDiagnostics.Explain("mail.example.com", 587, true, "u", new SmtpException("535 5.7.8 bad credentials"));
        Assert.StartsWith("The server rejected the username or password.", msg);
    }

    [Fact]
    public void Explain_IncludesInnerExceptionDetail()
    {
        var ex = new SmtpException("Failure sending mail.", new IOException("Unable to read data: timed out"));
        var msg = SmtpDiagnostics.Explain("mail.example.com", 587, true, "u", ex);
        Assert.Contains("Couldn’t reach mail.example.com:587", msg);
        Assert.Contains("timed out", msg);
    }

    [Fact]
    public void Explain_UnknownError_ReturnsItUnchanged()
        => Assert.Equal("weird", SmtpDiagnostics.Explain("h", 587, true, "u", new Exception("weird")));

    [Theory]
    [InlineData("smtp.gmail.com", "abcd efgh ijkl mnop", "abcdefghijklmnop")]
    [InlineData("smtp.gmail.com", " abcd efgh ", "abcdefgh")]
    [InlineData("mail.example.com", "pass word", "pass word")] // other providers: untouched
    public void NormalizePassword_StripsGoogleDisplaySpacesOnly(string host, string input, string expected)
        => Assert.Equal(expected, SmtpDiagnostics.NormalizePassword(host, input));
}
