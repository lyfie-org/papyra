using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>Label/value rows shown as a small table under an email's text (who, when, where…).</summary>
public sealed record EmailDetail(string Label, string Value);

/// <summary>
/// Every Papyra email, framed the same way: a light, paper-toned card with the
/// wordmark, the message, a button for its link and an optional details table.
///
/// Callers still write plain text — the text part is sent as-is, and this turns
/// the same words into the HTML part — so no message can be pretty in one form
/// and stale in the other. A paragraph that ends in a URL becomes a button
/// (the URL stays visible underneath for clients that strip buttons).
///
/// Light only, on purpose: `color-scheme: light only` and explicit colours on
/// every element, so dark-mode mail apps don't invert it into mud. Table layout
/// and inline styles, because that is what mail clients actually render.
/// </summary>
public static partial class EmailTemplate
{
    // Papyra's paper palette (light theme tokens).
    private const string Page = "#f2ebe0";
    private const string Card = "#fdf8f2";
    private const string Edge = "#ddd5c8";
    private const string Ink = "#3d2c1e";
    private const string Muted = "#7a5c4e";
    private const string Sage = "#7aaa8a";
    private const string SageInk = "#0f2118";
    private const string Wash = "#ede8df";

    private const string Serif = "'Marcellus', Georgia, 'Times New Roman', serif";
    private const string Sans = "'Sora', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    [GeneratedRegex(@"https?://[^\s<>""]+")]
    private static partial Regex Url();

    [GeneratedRegex(@"^(?<lead>.*?)[:\s]*(?<url>https?://\S+)\s*$", RegexOptions.Singleline)]
    private static partial Regex TrailingUrl();

    public static string Render(string subject, string text, IReadOnlyList<EmailDetail>? details = null)
    {
        var body = new StringBuilder();
        string? button = null;
        string? buttonUrl = null;

        foreach (var para in text.Replace("\r\n", "\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = para.Trim();
            var m = TrailingUrl().Match(trimmed);
            if (button is null && m.Success && !m.Groups["lead"].Value.Contains("http", StringComparison.Ordinal))
            {
                // "Set a new one here:\nhttps://…" → a button labelled by its lead-in.
                var lead = m.Groups["lead"].Value.Trim().TrimEnd(':').Trim();
                buttonUrl = m.Groups["url"].Value;
                button = ButtonLabel(lead);
                if (lead.Length > 0 && !IsBareInstruction(lead)) body.Append(Paragraph(lead));
                continue;
            }
            body.Append(Paragraph(trimmed));
        }

        var sb = new StringBuilder();
        sb.Append("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">")
          .Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
          .Append("<meta name=\"color-scheme\" content=\"light only\"><meta name=\"supported-color-schemes\" content=\"light\">")
          .Append("<title>").Append(Enc(subject)).Append("</title>")
          .Append("<style>:root{color-scheme:light only;supported-color-schemes:light;}")
          .Append("a{color:#205c38;} @media (max-width:520px){.card{padding:28px 22px !important;}}</style>")
          .Append("</head>")
          .Append($"<body style=\"margin:0;padding:0;background:{Page};color:{Ink};-webkit-text-size-adjust:100%;\">")
          // Preheader: the grey line inbox lists show after the subject.
          .Append($"<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;\">{Enc(Preheader(text))}</div>")
          .Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:{Page};\"><tr><td align=\"center\" style=\"padding:40px 16px;\">")
          .Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;\">")
          // Wordmark
          .Append($"<tr><td style=\"padding:0 8px 18px;font-family:{Serif};font-size:26px;letter-spacing:-0.3px;color:{Ink};\">Papyra</td></tr>")
          // Card
          .Append($"<tr><td class=\"card\" style=\"background:{Card};border:1px solid {Edge};border-radius:16px;padding:36px 40px;\">")
          .Append($"<h1 style=\"margin:0 0 18px;font-family:{Serif};font-weight:400;font-size:24px;line-height:1.25;color:{Ink};\">{Enc(subject)}</h1>")
          .Append(body);

        if (button is not null && buttonUrl is not null)
        {
            sb.Append("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:26px 0 8px;\"><tr>")
              .Append($"<td style=\"border-radius:999px;background:{Sage};\">")
              .Append($"<a href=\"{Attr(buttonUrl)}\" style=\"display:inline-block;padding:12px 26px;font-family:{Sans};font-size:15px;font-weight:600;color:{SageInk};text-decoration:none;border-radius:999px;\">{Enc(button)}</a>")
              .Append("</td></tr></table>")
              .Append($"<p style=\"margin:10px 0 0;font-family:{Sans};font-size:12px;line-height:1.6;color:{Muted};word-break:break-all;\">Or open this link: <a href=\"{Attr(buttonUrl)}\" style=\"color:#205c38;\">{Enc(buttonUrl)}</a></p>");
        }

        if (details is { Count: > 0 })
        {
            sb.Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:26px 0 4px;background:{Wash};border-radius:12px;\">");
            foreach (var d in details)
            {
                sb.Append("<tr>")
                  .Append($"<td style=\"padding:9px 16px;font-family:{Sans};font-size:12px;color:{Muted};white-space:nowrap;vertical-align:top;width:34%;\">{Enc(d.Label)}</td>")
                  .Append($"<td style=\"padding:9px 16px 9px 0;font-family:{Sans};font-size:13px;color:{Ink};word-break:break-word;\">{Enc(d.Value)}</td>")
                  .Append("</tr>");
            }
            sb.Append("</table>");
        }

        sb.Append("</td></tr>")
          // Footer
          .Append($"<tr><td style=\"padding:20px 8px 0;font-family:{Sans};font-size:12px;line-height:1.6;color:{Muted};\">")
          .Append("Sent by your Papyra — a notebook you run yourself. You're getting this because of your account there.")
          .Append("</td></tr></table></td></tr></table></body></html>");
        return sb.ToString();
    }

    /// <summary>The plain-text part, with the details appended as aligned lines.</summary>
    public static string PlainText(string text, IReadOnlyList<EmailDetail>? details)
    {
        if (details is not { Count: > 0 }) return text;
        var width = details.Max(d => d.Label.Length) + 2;
        var sb = new StringBuilder(text.TrimEnd()).Append("\n\n");
        foreach (var d in details) sb.Append((d.Label + ":").PadRight(width)).Append(d.Value).Append('\n');
        return sb.ToString();
    }

    private static string Paragraph(string text)
    {
        var html = Enc(text).Replace("\n", "<br>");
        html = Url().Replace(html, m => $"<a href=\"{m.Value}\" style=\"color:#205c38;\">{m.Value}</a>");
        return $"<p style=\"margin:0 0 14px;font-family:{Sans};font-size:15px;line-height:1.65;color:{Ink};\">{html}</p>";
    }

    // "Set a new one here" → "Set a new one"; "Open it in Papyra" stays.
    private static string ButtonLabel(string lead)
    {
        if (lead.Length == 0) return "Open Papyra";
        var label = Regex.Replace(lead, @"\s+(here|below)$", "", RegexOptions.IgnoreCase).Trim();
        if (label.Length > 40 || label.Contains('.')) return "Open Papyra";
        return char.ToUpperInvariant(label[0]) + label[1..];
    }

    // A lead that only says "click this" adds nothing once it is the button itself.
    private static bool IsBareInstruction(string lead) => ButtonLabel(lead) != "Open Papyra";

    private static string Preheader(string text)
    {
        var first = text.Replace("\r\n", "\n").Split("\n\n")[0].Replace('\n', ' ').Trim();
        first = Url().Replace(first, "").Trim();
        return first.Length > 110 ? first[..110] + "…" : first;
    }

    private static string Enc(string s) => WebUtility.HtmlEncode(s);
    private static string Attr(string s) => WebUtility.HtmlEncode(s);
}
