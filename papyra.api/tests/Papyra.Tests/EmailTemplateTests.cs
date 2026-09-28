using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class EmailTemplateTests
{
    [Fact]
    public void Render_IsLightOnly_TurnsTheLinkIntoAButton_AndEscapes()
    {
        var html = EmailTemplate.Render(
            "Reset your Papyra password",
            "Someone asked to reset the password for \"bea\" <script>.\n\nSet a new one here:\nhttps://papyra.example.com/reset-password?token=abc\n\nThis link expires in 1 hour.",
            [new EmailDetail("From IP address", "203.0.113.9")]);

        Assert.Contains("color-scheme\" content=\"light only\"", html);
        Assert.Contains(">Set a new one</a>", html);                          // the lead-in became the button
        Assert.Contains("href=\"https://papyra.example.com/reset-password?token=abc\"", html);
        Assert.Contains("&lt;script&gt;", html);                             // text is escaped
        Assert.DoesNotContain("<script>", html);
        Assert.Contains("203.0.113.9", html);                                // details table

        // Handy for eyeballing the design: open this file in a browser.
        File.WriteAllText(Path.Combine(Path.GetTempPath(), "papyra-email-preview.html"), html);
    }

    [Fact]
    public void PlainText_AppendsAlignedDetails()
    {
        var text = EmailTemplate.PlainText("Hello.", [new EmailDetail("When", "today"), new EmailDetail("IP", "1.2.3.4")]);
        Assert.Contains("When: today", text);
        Assert.Contains("IP:   1.2.3.4", text);
    }
}
