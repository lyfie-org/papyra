using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Papyra.Api.Security;

/// <summary>
/// Turns a log call into text that is safe to show an administrator and paste
/// into a public bug report: no note titles, ids, paths, user names, emails,
/// addresses or tokens — nothing that says whose data or which data.
///
/// Two layers. Structured values (the <c>{Placeholders}</c> of a log template)
/// are an allow-list: a value is shown only when its placeholder name says it
/// is a count, a status, a job id, a duration — everything else becomes its
/// name in guillemets (<c>‹User›</c>), so the line still reads. Free text that
/// can't be kept out (an exception's message, a child process's output line) is
/// scrubbed by pattern: quoted strings, paths, file names, URLs, emails, GUIDs,
/// long ids and tokens, IP addresses and <c>key=value</c> pairs are all replaced.
/// </summary>
public static partial class LogScrubber
{
    // Words that describe what happened, never whose data it happened to.
    private static readonly HashSet<string> SafeNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Status", "StatusCode", "Kind", "JobId", "Job", "Method", "Code", "Versions", "Version",
        "Tool", "Scheme", "Event", "Model", "Provider", "ErrorId", "Route", "Level", "Phase",
        "Signal", "Feature",
    };

    // Amounts: shown only when the value really is a number (or a duration),
    // so a future "{Moved}" carrying a note's name still comes out as ‹Moved›.
    private static readonly HashSet<string> CountNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Count", "Total", "Port", "Pid", "Delay", "Chars", "Attempts", "Failures", "Elapsed",
        "ElapsedMs", "Ms", "Seconds", "Duration", "DurationMs", "Bytes", "Size", "Interval",
        "Retries", "Limit", "Rooms", "Connections",
        // Tallies from sweeps and boot ("{Loaded} note(s) on disk, {Indexed} indexed").
        "Loaded", "Indexed", "Removed", "Deleted", "Purged", "Pruned", "Moved", "Renamed",
        "Skipped", "Added", "Updated", "Failed", "Sealed", "Scanned",
    };

    // Text we can't avoid logging, but can scrub.
    private static readonly HashSet<string> FreeTextNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Message", "Reason", "Error", "Line", "Detail", "Details", "Summary",
    };

    private const string OriginalFormat = "{OriginalFormat}";

    /// <summary>The message of one log call, rendered safe.</summary>
    public static string Render<TState>(TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        if (state is IReadOnlyList<KeyValuePair<string, object?>> pairs)
        {
            string? template = null;
            var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var (key, value) in pairs)
            {
                if (key == OriginalFormat) template = value as string;
                else values.TryAdd(key, value);
            }
            if (template is not null) return Limit(RenderTemplate(template, values));
        }
        // No template (a hand-built state): all of it is free text.
        string text;
        try { text = formatter(state, exception); }
        catch { text = ""; }
        return Limit(Scrub(text));
    }

    /// <summary>A message template with each placeholder replaced by its safe value or name.</summary>
    public static string RenderTemplate(string template, IReadOnlyDictionary<string, object?> values)
    {
        var rendered = Placeholder().Replace(template, m =>
        {
            if (m.Value.StartsWith("{{")) return "{";
            if (m.Value.StartsWith("}}")) return "}";
            var name = m.Groups["name"].Value.TrimStart('@', '$');
            values.TryGetValue(name, out var value);
            return SafeValue(name, value);
        });
        // The template itself is code, but a template built at runtime would carry
        // data; scrubbing it costs nothing when it is clean.
        return Scrub(rendered);
    }

    private static string SafeValue(string name, object? value)
    {
        if (CountNames.Contains(name))
        {
            return value switch
            {
                sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal
                    => ((IFormattable)value).ToString(null, CultureInfo.InvariantCulture),
                TimeSpan span => span.ToString("c", CultureInfo.InvariantCulture),
                _ => $"‹{name}›",
            };
        }
        if (SafeNames.Contains(name))
        {
            var text = value switch
            {
                null => "null",
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? "",
            };
            // A route template is safe as written ("/api/notes/{id}"); anything
            // else still goes through the scrubber in case a value surprises us.
            return name.Equals("Route", StringComparison.OrdinalIgnoreCase) ? text : Scrub(text);
        }
        if (FreeTextNames.Contains(name)) return value is null ? "" : Scrub(value.ToString() ?? "");
        return $"‹{name}›";
    }

    /// <summary>Best-effort removal of anything that could identify a person or their data.</summary>
    public static string Scrub(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var s = text;
        s = Url().Replace(s, "‹url›");
        s = Email().Replace(s, "‹email›");
        s = Quoted().Replace(s, m => $"{m.Value[0]}‹redacted›{m.Value[^1]}");
        s = WindowsPath().Replace(s, "‹path›");
        s = UnixPath().Replace(s, "‹path›");
        s = Guid().Replace(s, "‹id›");
        s = IpV4().Replace(s, "‹ip›");
        s = IpV6().Replace(s, "‹ip›");
        s = FileName().Replace(s, "‹file›");
        s = KeyValue().Replace(s, m => $"{m.Groups["key"].Value}{m.Groups["sep"].Value}‹redacted›");
        s = Bracketed().Replace(s, "[‹…›]");
        s = HexRun().Replace(s, "‹id›");
        s = TokenRun().Replace(s, "‹token›");
        return s;
    }

    /// <summary>
    /// An exception as a type, a scrubbed message and its frames — method names
    /// and line numbers, without the build machine's source paths. Inner
    /// exceptions follow, the way the runtime prints them.
    /// </summary>
    public static (string Type, string Message, string Stack) Describe(Exception exception)
    {
        var stack = new StringBuilder();
        var depth = 0;
        for (var e = exception; e is not null && depth < 4; e = e.InnerException, depth++)
        {
            if (depth > 0) stack.Append("---> ").Append(e.GetType().FullName).Append(": ").AppendLine(Scrub(e.Message));
            foreach (var line in (e.StackTrace ?? "").Split('\n').Take(40))
            {
                var frame = line.Trim();
                if (frame.Length == 0) continue;
                frame = SourceLocation().Replace(frame, m => $" (line {m.Groups["line"].Value})");
                stack.Append("   ").AppendLine(Scrub(frame));
            }
        }
        return (exception.GetType().FullName ?? exception.GetType().Name, Limit(Scrub(exception.Message)), Limit(stack.ToString().TrimEnd(), 12_000));
    }

    private static string Limit(string text, int max = 2_000) =>
        text.Length <= max ? text : text[..max] + "…";

    [GeneratedRegex(@"\{\{|\}\}|\{(?<name>[^{}:,]+)(?:[,:][^{}]*)?\}")]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"\b[a-z][a-z0-9+.\-]*://[^\s'""<>)\]]+", RegexOptions.IgnoreCase)]
    private static partial Regex Url();

    [GeneratedRegex(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")]
    private static partial Regex Email();

    [GeneratedRegex(@"'[^'\r\n]*'|""[^""\r\n]*""|‘[^’\r\n]*’|“[^”\r\n]*”|`[^`\r\n]*`")]
    private static partial Regex Quoted();

    [GeneratedRegex(@"\b[A-Za-z]:[\\/][^\s'""<>|]*|\\\\[^\s'""<>|]+")]
    private static partial Regex WindowsPath();

    // A slash-led run that is not part of a word ("and/or" survives; "/data/x" doesn't).
    [GeneratedRegex(@"(?<![\w.:/~-])/(?:[^\s/'""<>()]+/?)+")]
    private static partial Regex UnixPath();

    [GeneratedRegex(@"\b[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\b")]
    private static partial Regex Guid();

    [GeneratedRegex(@"\b(?:\d{1,3}\.){3}\d{1,3}\b")]
    private static partial Regex IpV4();

    [GeneratedRegex(@"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b")]
    private static partial Regex IpV6();

    [GeneratedRegex(@"[\w\-.]+\.(?:md|markdown|txt|png|jpe?g|gif|webp|avif|heic|heif|svg|bmp|tiff?|pdf|mp4|m4v|mov|webm|mkv|mp3|m4a|wav|ogg|oga|flac|aac|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|json|zip|enc|age)\b", RegexOptions.IgnoreCase)]
    private static partial Regex FileName();

    [GeneratedRegex(@"\b(?<key>user(?:name)?|uid|email|name|title|note|path|file|dir|folder|id|token|password|secret|key|account|room|host|ip)(?<sep>\s*[=:]\s*)[^\s,;)\]]+", RegexOptions.IgnoreCase)]
    private static partial Regex KeyValue();

    // "[room-name] saved" from the collab engine; tags like [collab] stay.
    [GeneratedRegex(@"\[(?!collab\])[^\]\r\n]{1,200}\]")]
    private static partial Regex Bracketed();

    [GeneratedRegex(@"\b[0-9a-fA-F]{12,}\b")]
    private static partial Regex HexRun();

    // Long opaque runs with digits in them (base64, JWT pieces, API keys) — never
    // a word anyone wrote, and never a method name in a stack frame.
    [GeneratedRegex(@"(?<![\w‹])(?=[A-Za-z_\-+/=]*\d)[A-Za-z0-9_\-+/=]{24,}(?![\w›])")]
    private static partial Regex TokenRun();

    [GeneratedRegex(@" in .*?:line (?<line>\d+)")]
    private static partial Regex SourceLocation();
}
