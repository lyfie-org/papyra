using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Security;

// Response hardening for the SPA Papyra serves from its own wwwroot.
//
// The pure parts (hashing the shipped inline scripts, assembling the policy
// strings) are static and side-effect free so they can be asserted directly;
// Program.cs only decides *when* to attach them.
public static partial class SecurityHeaders
{
    // An inline <script> — one with no src attribute. Its exact bytes are what a
    // CSP hash covers, so the capture must not be trimmed or re-indented.
    [GeneratedRegex(@"<script(?![^>]*\bsrc\s*=)[^>]*>(?<body>.*?)</script>",
        RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex InlineScript();

    /// <summary>
    /// CSP source tokens ('sha256-…') for every inline script in the given HTML.
    /// Computed from the deployed index.html at startup rather than hard-coded, so
    /// editing the anti-flash theme script can never silently break the page: the
    /// hash follows whatever actually shipped.
    /// </summary>
    public static IReadOnlyList<string> InlineScriptHashes(string html)
    {
        var hashes = new List<string>();
        if (string.IsNullOrEmpty(html)) return hashes;
        foreach (Match m in InlineScript().Matches(html))
        {
            var body = m.Groups["body"].Value;
            if (body.Length == 0) continue;
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(body));
            var token = $"'sha256-{Convert.ToBase64String(digest)}'";
            if (!hashes.Contains(token, StringComparer.Ordinal)) hashes.Add(token);
        }
        return hashes;
    }

    /// <summary>
    /// The policy for the app itself. Strict where XSS actually lands
    /// (script-src, object-src, base-uri, frame-ancestors); permissive where
    /// Papyra's own features need it, each noted below.
    /// </summary>
    public static string AppPolicy(IReadOnlyList<string> inlineScriptHashes)
    {
        var scriptSrc = inlineScriptHashes.Count > 0
            ? $"'self' {string.Join(' ', inlineScriptHashes)}"
            : "'self'";

        return string.Join("; ", [
            "default-src 'self'",
            $"script-src {scriptSrc}",
            // Lexical and React both set element styles at runtime, and the fonts
            // arrive as a Google Fonts stylesheet. Inline *styles* are not an
            // script-execution vector, so this is the cheap concession to make.
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            // Notes embed remote images through saved web cards, and local media
            // renders from blob: URLs before upload completes.
            "img-src 'self' data: blob: https:",
            "media-src 'self' blob:",
            // Same-origin API plus the SignalR socket; ws:/wss: are separate
            // schemes to CSP and are not covered by 'self'.
            "connect-src 'self' ws: wss:",
            // ![[youtube:…]] and ![[iframe:…]] embeds are a documented feature.
            "frame-src https:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]);
    }

    /// <summary>
    /// The carve-out for /docs and /openapi. Scalar serves its bundle same-origin
    /// but bootstraps from an inline module script it generates itself, so the
    /// hash would change with every Scalar upgrade and break the portal on a
    /// dependency bump. The portal is developer documentation, not a place user
    /// content is rendered, so relaxing script-src there costs nothing the app
    /// side is protecting.
    /// </summary>
    public static string DocsPolicy() => string.Join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ]);
}
