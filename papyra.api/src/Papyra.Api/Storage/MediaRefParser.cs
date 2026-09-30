using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// Which attachments a note body points at. Media lives flat in the user's media
/// dir and is referenced only by name, so "is this file part of that note?" —
/// the question behind share scoping, the vault gate and orphan pruning — is
/// answered by reading the body. Every form the editor, importers and older
/// notes produce is covered:
/// <list type="bullet">
///   <item><c>![[photo.png]]</c>, <c>![[photo.png|480]]</c>, <c>![[doc.pdf#page=3]]</c>, <c>[[doc.pdf]]</c></item>
///   <item><c>![alt](/api/media/photo.png)</c>, relative <c>![](attachments/photo.png)</c>, <c>&lt;url&gt;</c> forms</item>
///   <item>HTML <c>src=</c>/<c>href=</c> attributes, and bare <c>/api/media/…</c> URLs</item>
/// </list>
/// Names are compared case-insensitively (Obsidian embeds are) and reduced to
/// their last path segment (imports flatten folders into the media dir).
/// </summary>
public static partial class MediaRefParser
{
    [GeneratedRegex(@"!?\[\[([^\]\r\n]+)\]\]")]
    private static partial Regex WikiEmbed();

    [GeneratedRegex(@"\]\(\s*(<[^>\r\n]+>|[^)\s]+)")]
    private static partial Regex MarkdownLink();

    [GeneratedRegex(@"\b(?:src|href|poster)\s*=\s*(?:""([^""]*)""|'([^']*)')", RegexOptions.IgnoreCase)]
    private static partial Regex HtmlAttr();

    [GeneratedRegex(@"/api/(?:media|shared/[^/\s]+/media|shares/incoming/\d+/media)/([^\s)""'<>\]|#?]+)")]
    private static partial Regex ApiMediaUrl();

    /// <summary>Every attachment name the body references (case-insensitive set).</summary>
    public static HashSet<string> Extract(string? body)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(body)) return names;

        foreach (Match m in WikiEmbed().Matches(body))
        {
            var target = m.Groups[1].Value;
            var cut = target.IndexOfAny(['|', '#', '^']);
            if (cut >= 0) target = target[..cut];
            // `youtube:` / `iframe:` / `card:` embeds carry URLs, not attachments.
            if (target.Contains(':')) continue;
            Add(names, target);
        }
        foreach (Match m in MarkdownLink().Matches(body))
            AddUrl(names, m.Groups[1].Value.Trim('<', '>'));
        foreach (Match m in HtmlAttr().Matches(body))
            AddUrl(names, m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
        foreach (Match m in ApiMediaUrl().Matches(body))
            Add(names, Unescape(m.Groups[1].Value));
        return names;
    }

    private static void AddUrl(HashSet<string> names, string url)
    {
        if (url.Length == 0) return;
        var api = ApiMediaUrl().Match(url);
        if (api.Success) { Add(names, Unescape(api.Groups[1].Value)); return; }
        // Anything with a scheme, protocol-relative, rooted or a pure fragment is
        // a web address or an app route — never a vault attachment.
        if (url.StartsWith('/') || url.StartsWith('#') || url.Contains("://") || HasScheme(url)) return;
        var cut = url.IndexOfAny(['?', '#']);
        if (cut >= 0) url = url[..cut];
        Add(names, Unescape(url));
    }

    private static bool HasScheme(string url)
    {
        var colon = url.IndexOf(':');
        if (colon <= 0) return false;
        for (var i = 0; i < colon; i++)
            if (!char.IsAsciiLetterOrDigit(url[i]) && url[i] is not ('+' or '-' or '.')) return false;
        return true;
    }

    private static void Add(HashSet<string> names, string target)
    {
        target = target.Trim().Replace('\\', '/');
        var slash = target.LastIndexOf('/');
        if (slash >= 0) target = target[(slash + 1)..];
        if (target.Length is > 0 and <= 255 && target != "." && target != "..") names.Add(target);
    }

    private static string Unescape(string value)
    {
        try { return Uri.UnescapeDataString(value); }
        catch (UriFormatException) { return value; }
    }
}

/// <summary>
/// Cached view of which notes reference which attachment. A note's references
/// are parsed once per body (keyed on the note instance and its body string), so
/// answering "who references photo.png?" costs a hash lookup per note rather
/// than a regex pass over the whole vault on every image request.
/// </summary>
public sealed class MediaReferences(VaultState state)
{
    private sealed class Entry(string body, HashSet<string> names)
    {
        public string Body { get; } = body;
        public HashSet<string> Names { get; } = names;
    }

    private readonly ConditionalWeakTable<Note, Entry> _cache = new();

    /// <summary>The attachment names this note references.</summary>
    public IReadOnlySet<string> Of(Note note)
    {
        var body = note.Body ?? string.Empty;
        if (_cache.TryGetValue(note, out var hit) && ReferenceEquals(hit.Body, body)) return hit.Names;
        var entry = new Entry(body, MediaRefParser.Extract(body));
        _cache.AddOrUpdate(note, entry);
        return entry.Names;
    }

    /// <summary>True when this note's body references the attachment.</summary>
    public bool References(Note note, string filename) => Of(note).Contains(filename);

    /// <summary>The user's live notes that reference the attachment.</summary>
    public IEnumerable<Note> Referrers(string userId, string filename) =>
        state.Snapshot(userId).Where(n => References(n, filename));
}
