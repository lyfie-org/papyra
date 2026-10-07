using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Papyra.Api.Security;

/// <summary>
/// What someone sees when the server fails them: a reference they can quote and
/// (unless turned off) a short, trimmed stack trace they can send the admin.
///
/// Every unhandled exception gets an error id, logged beside the full exception,
/// so "it said E7K2-QX9M" finds the log line. API callers (and fetches) get it as
/// JSON the SPA renders; a browser navigation — the SSO callback, a server-side
/// redirect — gets a self-contained HTML page in Papyra's own look instead of the
/// browser's bare "HTTP ERROR 500".
///
/// Stack traces name code, not data: file paths are cut to the file name, and
/// <c>Papyra:ErrorDetails=false</c> (PAPYRA_ERROR_DETAILS) keeps them out of
/// responses entirely, leaving just the reference.
/// </summary>
public static partial class ErrorPages
{
    public sealed record Report(
        string ErrorId, int Status, string Title, string Message, string? Type, string? Detail, string? Stack,
        string Method, string Path, DateTime TimeUtc, string Version);

    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

    /// <summary>A short, readable reference: "E7K2-QX9M".</summary>
    public static string NewErrorId()
    {
        Span<byte> bytes = stackalloc byte[8];
        RandomNumberGenerator.Fill(bytes);
        var sb = new StringBuilder(9);
        for (var i = 0; i < 8; i++)
        {
            if (i == 4) sb.Append('-');
            sb.Append(Alphabet[bytes[i] % Alphabet.Length]);
        }
        return sb.ToString();
    }

    public static Report For(HttpContext http, Exception ex, string errorId, bool details, string version) => new(
        errorId,
        StatusCodes.Status500InternalServerError,
        "Something went wrong",
        "Papyra hit an unexpected error while handling this request. Nothing you did caused it.",
        details ? ex.GetType().FullName : null,
        details ? ex.Message : null,
        details ? TrimStack(ex) : null,
        http.Request.Method,
        http.Request.Path.Value ?? "/",
        DateTime.UtcNow,
        version);

    /// <summary>Whether the caller wants JSON (API, hubs, fetch) rather than a page.</summary>
    public static bool WantsJson(HttpRequest request)
    {
        var path = request.Path;
        if (path.StartsWithSegments("/api") || path.StartsWithSegments("/hubs")
            || path.StartsWithSegments("/collab") || path.StartsWithSegments("/internal")
            || path.StartsWithSegments("/health"))
            return true;
        return !request.Headers.Accept.ToString().Contains("text/html", StringComparison.OrdinalIgnoreCase);
    }

    public static object Json(Report r) => new
    {
        error = r.Message,
        code = "server_error",
        errorId = r.ErrorId,
        detail = r.Stack is null && r.Detail is null ? null : new
        {
            type = r.Type,
            message = r.Detail,
            stack = r.Stack,
            method = r.Method,
            path = r.Path,
            time = r.TimeUtc.ToString("O"),
            version = r.Version,
        },
    };

    [GeneratedRegex(@" in (?:[A-Za-z]:)?[^\s:]*[\\/]([^\\/:]+):line (\d+)")]
    private static partial Regex SourcePath();

    /// <summary>
    /// The exception chain as text, compacted: Papyra's own frames in full, at
    /// most a few framework frames per exception (the rest counted, not listed),
    /// source paths reduced to file names. Enough to find the bug; short enough
    /// to paste into a message.
    /// </summary>
    public static string TrimStack(Exception ex)
    {
        var sb = new StringBuilder();
        var depth = 0;
        for (var e = ex; e is not null && depth < 4; e = e.InnerException, depth++)
        {
            if (depth > 0) sb.Append("\n---> ");
            sb.Append(e.GetType().FullName).Append(": ").Append(e.Message.Trim());
            var frames = (e.StackTrace ?? string.Empty).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            int framework = 0, skipped = 0;
            foreach (var frame in frames)
            {
                if (frame.StartsWith("--- End of stack trace", StringComparison.Ordinal)) continue;
                var ours = frame.StartsWith("at Papyra", StringComparison.Ordinal) || frame.StartsWith("at Program", StringComparison.Ordinal);
                if (!ours && ++framework > 4) { skipped++; continue; }
                sb.Append("\n   ").Append(SourcePath().Replace(frame, " in $1:line $2"));
            }
            if (skipped > 0) sb.Append($"\n   … {skipped} more framework frame{(skipped == 1 ? "" : "s")}");
        }
        return sb.ToString();
    }

    /// <summary>The text a person copies to send the admin.</summary>
    public static string ReportText(Report r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Papyra error {r.ErrorId}");
        sb.AppendLine($"Time:    {r.TimeUtc:yyyy-MM-dd HH:mm:ss} UTC");
        sb.AppendLine($"Request: {r.Method} {r.Path}");
        sb.AppendLine($"Status:  {r.Status}");
        sb.AppendLine($"Version: {r.Version}");
        if (r.Stack is not null) { sb.AppendLine(); sb.AppendLine(r.Stack); }
        return sb.ToString();
    }

    /// <summary>A standalone page: no SPA, no external script — it must render when the app can't.</summary>
    public static string Html(Report r, string nonce)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? string.Empty);
        var report = ReportText(r);
        var details = r.Stack is null ? "" : $"""
            <details class="trace">
              <summary>Technical details</summary>
              <pre>{E(r.Stack)}</pre>
            </details>
            """;
        return $$"""
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta name="robots" content="noindex">
            <title>Something went wrong · Papyra</title>
            <link rel="icon" href="/favicon.ico">
            <link rel="stylesheet" href="/fonts/fonts.css">
            <style nonce="{{nonce}}">
              :root { --bg:#f2ebe0; --surface:#fdf8f2; --text:#7a5c4e; --text-h:#3d2c1e; --border:#e2d6c6; --accent:#7aaa8a; --accent-fg:#0f2118; --code-bg:#f6efe5; --danger:#a4452f; }
              @media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --surface:#28231e; --text:#a89070; --text-h:#f0e6d3; --border:#3a322a; --code-bg:#211d19; --danger:#e08a73; } }
              * { box-sizing: border-box; }
              body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--text); font:400 15px/1.6 Sora, system-ui, sans-serif; }
              main { width:min(640px,100%); background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:32px clamp(20px,5vw,40px); box-shadow:0 12px 40px rgb(61 44 30 / .08); }
              .brand { display:flex; align-items:center; gap:10px; margin-bottom:28px; font:400 20px/1 Marcellus, serif; color:var(--text-h); text-decoration:none; }
              .brand img { width:28px; height:28px; }
              .code { font:500 12px/1 Sora, sans-serif; letter-spacing:.08em; text-transform:uppercase; color:var(--danger); margin:0 0 8px; }
              h1 { font:400 clamp(26px,5vw,32px)/1.2 Marcellus, serif; color:var(--text-h); margin:0 0 12px; }
              p { margin:0 0 16px; }
              .ref { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border:1px solid var(--border); border-radius:999px; font:500 13px/1.4 "Roboto Mono", monospace; color:var(--text-h); }
              .trace { margin-top:20px; border:1px solid var(--border); border-radius:12px; background:var(--code-bg); }
              .trace summary { cursor:pointer; padding:10px 14px; font-weight:500; color:var(--text-h); }
              .trace pre { margin:0; padding:0 14px 14px; max-height:300px; overflow:auto; font:12px/1.55 "Roboto Mono", monospace; white-space:pre-wrap; word-break:break-word; color:var(--text); }
              .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:24px; }
              .btn { padding:10px 18px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--text-h); font:500 14px/1 Sora, sans-serif; cursor:pointer; text-decoration:none; }
              .btn--primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
              .btn:focus-visible { outline:2px solid var(--text-h); outline-offset:2px; }
            </style>
            </head>
            <body>
            <main>
              <a class="brand" href="/"><img src="/android-chrome-192x192.png" alt="">Papyra</a>
              <p class="code">Error {{r.Status}}</p>
              <h1>{{E(r.Title)}}</h1>
              <p>{{E(r.Message)}} If it keeps happening, send the details below to whoever runs this Papyra.</p>
              <span class="ref">Reference {{E(r.ErrorId)}}</span>
              {{details}}
              <div class="actions">
                <button type="button" class="btn btn--primary" id="copy">Copy error details</button>
                <a class="btn" href="/">Back to Papyra</a>
              </div>
              <textarea id="report" hidden>{{E(report)}}</textarea>
            </main>
            <script nonce="{{nonce}}">
              document.getElementById('copy').addEventListener('click', async function () {
                var text = document.getElementById('report').value + '\nPage: ' + location.href + '\nBrowser: ' + navigator.userAgent;
                try { await navigator.clipboard.writeText(text); this.textContent = 'Copied'; }
                catch (e) { var t = document.getElementById('report'); t.hidden = false; t.select(); this.textContent = 'Select and copy the text above'; }
              });
            </script>
            </body>
            </html>
            """;
    }

    /// <summary>Only the page's own nonce'd style and script run; nothing else.</summary>
    public static string HtmlCsp(string nonce) =>
        $"default-src 'none'; style-src 'nonce-{nonce}' 'self'; font-src 'self'; img-src 'self'; script-src 'nonce-{nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    /// <summary>Write the error in whichever shape the caller asked for.</summary>
    public static async Task WriteAsync(HttpContext http, Report report)
    {
        var response = http.Response;
        response.Clear();
        response.StatusCode = report.Status;
        response.Headers.CacheControl = "no-store";
        // Clear() dropped the hardening headers set earlier in the pipeline.
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.XFrameOptions = "DENY";
        if (WantsJson(http.Request))
        {
            await response.WriteAsJsonAsync(Json(report), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            return;
        }
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        response.Headers.ContentSecurityPolicy = HtmlCsp(nonce);
        response.ContentType = "text/html; charset=utf-8";
        await response.WriteAsync(Html(report, nonce));
    }
}
