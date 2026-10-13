using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>
/// Rewrite what a note body says when the thing it names is renamed: a wikilink
/// to a note whose title changed, an @mention of a person whose username changed.
/// Text inside code (fenced blocks, inline backticks) is not a link or a mention
/// and is left exactly as written. Matching ignores case — the editor resolves
/// links and usernames that way — and only the name itself is replaced, so an
/// alias (<c>[[Title|shown]]</c>) or a heading/block part (<c>[[Title#h]]</c>) stays.
/// </summary>
public static partial class TextRenames
{
    // Same shape as the web's lib/mentions (a username may hold . _ -, but a
    // sentence-ending "." is not part of it).
    private const string UsernameTail = @"(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])";

    [GeneratedRegex(@"^ {0,3}(`{3,}|~{3,})")]
    private static partial Regex FenceMarker();

    [GeneratedRegex("`[^`\n]*`")]
    private static partial Regex InlineCode();

    /// <summary>A title a wikilink can name: no brackets, pipes, hashes or line breaks.</summary>
    public static bool IsLinkableTitle(string title) =>
        title.Trim().Length > 0 && title.IndexOfAny(['[', ']', '|', '#', '\n', '\r']) < 0;

    /// <summary>Point links to <paramref name="oldTitle"/> at <paramref name="newTitle"/>.</summary>
    public static string RenameLinks(string body, string oldTitle, string newTitle)
    {
        oldTitle = oldTitle.Trim();
        newTitle = newTitle.Trim();
        if (!IsLinkableTitle(oldTitle) || !IsLinkableTitle(newTitle) || oldTitle == newTitle) return body;
        var link = new Regex(@"(!?\[\[[ \t]*)" + Regex.Escape(oldTitle) + @"(?=[ \t]*(?:\||#|\]\]))",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        return OutsideCode(body, text => link.Replace(text, m => m.Groups[1].Value + newTitle));
    }

    /// <summary>Change <c>@oldName</c> mentions to <c>@newName</c>.</summary>
    public static string RenameMentions(string body, string oldName, string newName)
    {
        if (oldName.Length == 0 || newName.Length == 0 || oldName == newName) return body;
        var mention = new Regex(@"(?<=^|[\s(\[])@" + Regex.Escape(oldName) + UsernameTail,
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Multiline);
        return OutsideCode(body, text => mention.Replace(text, "@" + newName));
    }

    /// <summary>Apply <paramref name="rewrite"/> to every stretch of the body that isn't code.</summary>
    private static string OutsideCode(string body, Func<string, string> rewrite)
    {
        var lines = body.Split('\n');
        var output = new StringBuilder(body.Length + 16);
        var prose = new StringBuilder();
        string? fence = null;

        void FlushProse()
        {
            if (prose.Length == 0) return;
            output.Append(RewriteOutsideInlineCode(prose.ToString(), rewrite));
            prose.Clear();
        }

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i] + (i < lines.Length - 1 ? "\n" : "");
            var marker = FenceMarker().Match(lines[i]);
            if (fence is not null)
            {
                output.Append(line);
                if (marker.Success && marker.Groups[1].Value[0] == fence[0] && marker.Groups[1].Value.Length >= fence.Length)
                    fence = null;
                continue;
            }
            if (marker.Success)
            {
                FlushProse();
                fence = marker.Groups[1].Value;
                output.Append(line);
                continue;
            }
            prose.Append(line);
        }
        FlushProse();
        return output.ToString();
    }

    private static string RewriteOutsideInlineCode(string text, Func<string, string> rewrite)
    {
        var output = new StringBuilder(text.Length);
        var at = 0;
        foreach (Match code in InlineCode().Matches(text))
        {
            output.Append(rewrite(text[at..code.Index]));
            output.Append(code.Value);
            at = code.Index + code.Length;
        }
        output.Append(rewrite(text[at..]));
        return output.ToString();
    }
}
