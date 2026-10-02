using System.Text.RegularExpressions;
using Markdig;
using Markdig.Extensions.Yaml;
using Markdig.Syntax;
using Papyra.Api.Models;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Papyra.Api.Storage;

// Zero-trust markdown engine: the .md file (YAML frontmatter + body) is the
// source of truth. Reads/writes are crash-safe (atomic replace) and tolerant of
// foreign YAML keys (Obsidian/Syncthing etc.) — unknown keys are preserved, never
// stripped, never fatal. A locked note's title and body are sealed on the way
// to disk and opened on the way back (see LockedNoteCipher), so every caller
// above this works with readable notes. Registered as a singleton.
public sealed partial class MarkdownStorageService
{
    // Known frontmatter keys we own; everything else is foreign and preserved.
    private const string KeyId = "id";
    private const string KeyTitle = "title";
    private const string KeyTags = "tags";
    private const string KeyColor = "color";
    private const string KeyPinned = "pinned";
    private const string KeyArchived = "archived";
    private const string KeyTrashed = "trashed";
    private const string KeyTrashedAt = "trashedAt";
    private const string KeyKind = "kind";
    private const string KeySecure = "secure";

    // The keys we own; anything else in the frontmatter is foreign and preserved.
    private static readonly HashSet<string> KnownKeys = new(StringComparer.OrdinalIgnoreCase)
        { KeyId, KeyTitle, KeyTags, KeyColor, KeyPinned, KeyArchived, KeyTrashed, KeyTrashedAt, KeyKind, KeySecure };

    private const int MaxRetries = 3;
    private const int BaseDelayMs = 50;

    private readonly MarkdownPipeline _pipeline = new MarkdownPipelineBuilder()
        .UseYamlFrontMatter()
        .Build();

    private readonly IDeserializer _yamlReader = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .IgnoreUnmatchedProperties()
        .Build();

    private readonly ISerializer _yamlWriter = new SerializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .Build();

    // Null in unit tests that exercise the format alone: locked notes then stay readable.
    private readonly LockedNoteCipher? _cipher;

    public MarkdownStorageService(LockedNoteCipher? cipher = null) => _cipher = cipher;

    // ── Pure (string ⇄ Note) ────────────────────────────────────────────────

    // Parse a raw .md document into a Note. Never throws on unknown/garbage YAML.
    // With the file's `path`, a sealed locked note is opened with its owner's key;
    // one that can't be (another user's, or damaged) keeps the envelope as its
    // body, which Serialize writes back untouched.
    public Note Deserialize(string content, string? path = null)
    {
        var (frontmatter, body) = SplitFrontmatter(content ?? string.Empty);

        var note = new Note
        {
            Id = GetString(frontmatter, KeyId) ?? string.Empty,
            Title = GetString(frontmatter, KeyTitle) ?? string.Empty,
            Tags = GetTags(frontmatter),
            Color = GetString(frontmatter, KeyColor),
            Pinned = GetBool(frontmatter, KeyPinned),
            Archived = GetBool(frontmatter, KeyArchived),
            Kind = GetString(frontmatter, KeyKind) ?? "note",
            Trashed = GetBool(frontmatter, KeyTrashed),
            TrashedAt = GetDateTime(frontmatter, KeyTrashedAt),
            Secure = GetBool(frontmatter, KeySecure),
            Body = body,
            // Carry every non-owned key so a fresh write (import) preserves it too.
            ExtraFrontmatter = frontmatter
                .Where(kv => !KnownKeys.Contains(kv.Key))
                .ToDictionary(kv => kv.Key, kv => kv.Value),
        };

        if (note.Secure)
        {
            if (!LockedNoteCipher.IsEnvelope(body)) note.NeedsSealing = _cipher is not null;
            else if (_cipher?.UserFor(path) is { } uid && _cipher.TryOpen(uid, body, out var title, out var plain))
            {
                note.Title = title;
                note.Body = plain;
            }
        }
        // A locked note's title lives in its envelope, never in a `title:` key.
        note.TitleMissing = !note.Secure && GetString(frontmatter, KeyTitle) is null;
        return note;
    }

    // Render a Note back to a .md document. Foreign keys are merged through
    // untouched: first from the note's own carried bag (so imports keep them), then
    // overlaid by `preserve` — the existing file's frontmatter — which wins, since
    // that reflects whatever a sync tool most recently wrote to disk.
    //
    // With the destination `path` under a user's dir, a locked note is sealed:
    // no `title` key, and the body is the envelope. Without one (an export, a
    // backup's readable vault/) it is written readable.
    public string Serialize(Note note, IDictionary<string, object?>? preserve = null, string? path = null)
    {
        var fm = new Dictionary<string, object?>(note.ExtraFrontmatter);
        if (preserve is not null)
            foreach (var (k, v) in preserve) fm[k] = v;

        fm[KeyId] = note.Id;
        fm[KeyTitle] = note.Title;
        fm[KeyTags] = note.Tags;
        fm[KeyColor] = note.Color;
        fm[KeyPinned] = note.Pinned;
        fm[KeyArchived] = note.Archived;
        // Keep YAML clean: only stamp kind when it's not the default note. The
        // non-default kinds are enumerated rather than written through verbatim,
        // so a client can't invent one — but every one of them MUST persist, or
        // the note silently reverts to a plain note on the next read (an inbox
        // would reappear on the notes desk).
        if (string.Equals(note.Kind, "todo", StringComparison.OrdinalIgnoreCase)) fm[KeyKind] = "todo";
        else if (string.Equals(note.Kind, "inbox", StringComparison.OrdinalIgnoreCase)) fm[KeyKind] = "inbox";
        else fm.Remove(KeyKind);
        // Likewise only stamp `secure` while the note is actually locked.
        if (note.Secure) fm[KeySecure] = true;
        else fm.Remove(KeySecure);
        // Keep the frontmatter clean: only stamp trash keys while actually trashed.
        if (note.Trashed)
        {
            fm[KeyTrashed] = true;
            fm[KeyTrashedAt] = (note.TrashedAt ?? DateTime.UtcNow).ToString("o");
        }
        else
        {
            fm.Remove(KeyTrashed);
            fm.Remove(KeyTrashedAt);
        }

        var body = note.Body;
        if (note.Secure && LockedNoteCipher.IsEnvelope(body))
        {
            // Couldn't be opened on read: carry the sealed text through as it was.
            fm.Remove(KeyTitle);
            body = body.Trim();
        }
        else if (note.Secure && _cipher?.UserFor(path) is { } uid)
        {
            fm.Remove(KeyTitle);
            body = _cipher.Seal(uid, note.Title, note.Body);
        }

        var yaml = _yamlWriter.Serialize(fm).TrimEnd('\n', '\r');
        return $"---\n{yaml}\n---\n\n{body}";
    }

    // ── Disk (crash-safe I/O) ────────────────────────────────────────────────

    // Read a note from disk. Returns null if the file is absent.
    public async Task<Note?> ReadAsync(string path, CancellationToken ct = default)
    {
        if (!File.Exists(path)) return null;
        var content = await WithBackoff(() => File.ReadAllTextAsync(path, ct));
        var note = Deserialize(content, path);
        // mtime is the source of "last modified" — not a frontmatter key.
        note.Updated = File.GetLastWriteTimeUtc(path);
        // Made by another tool: name it the way that tool shows it — its first
        // heading, else its file name. Derived on every read rather than written
        // into the file, so it follows the heading while the other tool owns the
        // note; Papyra's first save of it stamps the title for good.
        if (note.TitleMissing) note.Title = QuickImport.TitleFrom(note.Body, path);
        return note;
    }

    // Add an `id:` to a file another tool wrote without one (see
    // ForeignNoteAdopter). Unlike WriteAsync this re-renders nothing: one line is
    // added (or a blank `id:` filled in) and every other byte — foreign keys, their
    // order and comments, the body — stays as that tool wrote it. The file keeps its
    // mtime, so adopting a note doesn't read as an edit to the grid, the cold-boot
    // diff or a sync tool. Returns false, writing nothing, when the file can't be
    // stamped safely (unparseable YAML, an odd `id:` shape) or changed under us
    // mid-stamp — the next watcher event for it tries again.
    public async Task<bool> TryStampIdAsync(string path, string id, CancellationToken ct = default)
    {
        var before = new FileInfo(path);
        if (!before.Exists) return false;
        var (mtime, length) = (before.LastWriteTimeUtc, before.Length);

        var content = await WithBackoff(() => File.ReadAllTextAsync(path, ct));
        if (StampId(content, id) is not { } stamped) return false;

        // Another program writing the file between our read and our replace
        // would lose its write; skip rather than clobber it.
        var replaced = await ReplaceAtomicallyAsync(path, stamped, ct, stillCurrent: () =>
        {
            var now = new FileInfo(path);
            return now.Exists && now.LastWriteTimeUtc == mtime && now.Length == length;
        });
        if (replaced) File.SetLastWriteTimeUtc(path, mtime);
        return replaced;
    }

    // Pure half of TryStampIdAsync: `content` with `id` written into its
    // frontmatter (one created if it has none), or null when that can't be done
    // without guessing at the YAML. Line endings follow the file's own.
    internal string? StampId(string content, string id)
    {
        var nl = content.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        // Quoted: an id that looks like a YAML number or `null` must read back as
        // the same string.
        var line = $"{KeyId}: '{id.Replace("'", "''")}'";

        var doc = Markdown.Parse(content, _pipeline);
        var block = doc.Descendants<YamlFrontMatterBlock>().FirstOrDefault();
        // No frontmatter: give it one. SplitFrontmatter drops exactly the blank
        // line written after the fence, so the body reads back as it did before
        // (leading blank lines were already trimmed from it then).
        if (block is null) return $"---{nl}{line}{nl}---{nl}{nl}{content.TrimStart('\r', '\n')}";

        Dictionary<string, object?>? fm;
        try { fm = _yamlReader.Deserialize<Dictionary<string, object?>>(FrontmatterYaml(content, block)); }
        catch { return null; } // broken YAML: adding a line can't be trusted to fix it
        fm ??= [];

        var firstBreak = content.IndexOf('\n');
        if (firstBreak < 0) return null;
        if (!fm.ContainsKey(KeyId))
            return content[..(firstBreak + 1)] + line + nl + content[(firstBreak + 1)..];

        // A present but blank `id:` — replace that one line. Writing a second key
        // would make the YAML a duplicate-key error and lose every other key.
        if (!string.IsNullOrWhiteSpace(GetString(fm, KeyId))) return null;
        var matches = BlankIdLine().Matches(content[..(block.Span.End + 1)]);
        if (matches.Count != 1) return null;
        var m = matches[0];
        return content[..m.Index] + line + content[(m.Index + m.Length)..];
    }

    [GeneratedRegex(@"^id[ \t]*:[ \t]*(?:''|""{2}|~|null|Null|NULL)?[ \t]*(?=\r?$)", RegexOptions.Multiline)]
    private static partial Regex BlankIdLine();

    // Atomically persist a note: write a uuid.tmp sibling, fsync, then replace the
    // target in one move. Never leaves a 0-byte .md behind. Foreign frontmatter on
    // the existing file is preserved — unless `mergeExisting` is false, when the
    // note's own ExtraFrontmatter is the whole story (an import overwrite, whose
    // caller has already merged the old keys under the incoming ones).
    public async Task WriteAsync(string path, Note note, CancellationToken ct = default, bool mergeExisting = true)
    {
        var existing = mergeExisting && File.Exists(path)
            ? SplitFrontmatter(await WithBackoff(() => File.ReadAllTextAsync(path, ct))).Frontmatter
            : null;

        var content = Serialize(note, existing, path);
        await ReplaceAtomicallyAsync(path, content, ct);
    }

    // Write a uuid.tmp sibling, fsync, then swap it in with one move. With
    // `stillCurrent`, the swap only happens if that still holds once the new text
    // is safely on disk (the tmp is discarded otherwise); returns whether it did.
    private static async Task<bool> ReplaceAtomicallyAsync(
        string path, string content, CancellationToken ct, Func<bool>? stillCurrent = null)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var tmp = Path.Combine(dir ?? ".", $"{Guid.NewGuid():N}.tmp");

        await WithBackoff(async () =>
        {
            await using (var fs = new FileStream(
                tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(content);
                await fs.WriteAsync(bytes, ct);
                await fs.FlushAsync(ct);
                fs.Flush(flushToDisk: true); // fsync — durability before replace
            }
            return true;
        });

        if (stillCurrent is not null && !stillCurrent())
        {
            File.Delete(tmp);
            return false;
        }

        // Replace is atomic where the destination exists; fall back to a move
        // (overwrite) for first writes when there's nothing to replace.
        await WithBackoff(() =>
        {
            if (File.Exists(path))
                File.Replace(tmp, path, destinationBackupFileName: null);
            else
                File.Move(tmp, path, overwrite: true);
            return Task.FromResult(true);
        });
        return true;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    // Split a document into its frontmatter dictionary + markdown body using
    // Markdig to locate the YAML block. Missing/invalid YAML yields an empty map.
    private (Dictionary<string, object?> Frontmatter, string Body) SplitFrontmatter(string content)
    {
        var doc = Markdown.Parse(content, _pipeline);
        var block = doc.Descendants<YamlFrontMatterBlock>().FirstOrDefault();
        if (block is null)
            return (new Dictionary<string, object?>(), content.TrimStart('\r', '\n'));

        var yamlText = FrontmatterYaml(content, block);

        // Drop the fence's own line ending and the one blank line Serialize writes
        // after it — no more. Blank lines beyond that are the note's own: the
        // editor stores a blank first line as a leading newline, and trimming
        // every newline here deleted it on each read.
        var body = StripOneLineBreak(StripOneLineBreak(content.Substring(block.Span.End + 1)));

        Dictionary<string, object?> fm;
        try
        {
            fm = _yamlReader.Deserialize<Dictionary<string, object?>>(yamlText)
                 ?? new Dictionary<string, object?>();
        }
        catch
        {
            fm = new Dictionary<string, object?>(); // graceful ignorance
        }

        return (fm, body);
    }

    // The YAML between a frontmatter block's `---` fence lines.
    private static string FrontmatterYaml(string content, YamlFrontMatterBlock block)
    {
        var raw = content.Substring(block.Span.Start, block.Span.Length);
        var lines = raw.Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count > 0 && lines[0].TrimEnd() == "---") lines.RemoveAt(0);
        if (lines.Count > 0 && lines[^1].TrimEnd() == "---") lines.RemoveAt(lines.Count - 1);
        return string.Join('\n', lines);
    }

    private static string StripOneLineBreak(string s) =>
        s.StartsWith("\r\n", StringComparison.Ordinal) ? s[2..]
        : s.StartsWith('\n') || s.StartsWith('\r') ? s[1..]
        : s;

    private static string? GetString(IDictionary<string, object?> fm, string key)
        => fm.TryGetValue(key, out var v) && v is not null ? v.ToString() : null;

    private static bool GetBool(IDictionary<string, object?> fm, string key)
        => GetString(fm, key) is { } s && bool.TryParse(s, out var b) && b;

    private static DateTime? GetDateTime(IDictionary<string, object?> fm, string key)
        => GetString(fm, key) is { } s
           && DateTime.TryParse(s, null, System.Globalization.DateTimeStyles.RoundtripKind, out var dt)
            ? dt : null;

    private static List<string> GetTags(IDictionary<string, object?> fm)
    {
        if (!fm.TryGetValue(KeyTags, out var v) || v is null) return [];
        if (v is IEnumerable<object?> list)
            return list.Where(x => x is not null).Select(x => x!.ToString()!).ToList();
        // CSV fallback for `tags: a, b, c`.
        return v.ToString()!
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();
    }

    // Exponential backoff around lock-prone I/O: a sync tool holding the file
    // briefly should not crash us. Rethrows the last IOException after MaxRetries.
    private static async Task<T> WithBackoff<T>(Func<Task<T>> action)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await action();
            }
            catch (IOException) when (attempt < MaxRetries - 1)
            {
                await Task.Delay(BaseDelayMs * (1 << attempt));
            }
        }
    }
}
