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
// stripped, never fatal. Registered as a singleton.
public sealed class MarkdownStorageService
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

    // The keys we own; anything else in the frontmatter is foreign and preserved.
    private static readonly HashSet<string> KnownKeys = new(StringComparer.OrdinalIgnoreCase)
        { KeyId, KeyTitle, KeyTags, KeyColor, KeyPinned, KeyArchived, KeyTrashed, KeyTrashedAt };

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

    // ── Pure (string ⇄ Note) ────────────────────────────────────────────────

    // Parse a raw .md document into a Note. Never throws on unknown/garbage YAML.
    public Note Deserialize(string content)
    {
        var (frontmatter, body) = SplitFrontmatter(content ?? string.Empty);

        return new Note
        {
            Id = GetString(frontmatter, KeyId) ?? string.Empty,
            Title = GetString(frontmatter, KeyTitle) ?? string.Empty,
            Tags = GetTags(frontmatter),
            Color = GetString(frontmatter, KeyColor),
            Pinned = GetBool(frontmatter, KeyPinned),
            Archived = GetBool(frontmatter, KeyArchived),
            Trashed = GetBool(frontmatter, KeyTrashed),
            TrashedAt = GetDateTime(frontmatter, KeyTrashedAt),
            Body = body,
            // Carry every non-owned key so a fresh write (import) preserves it too.
            ExtraFrontmatter = frontmatter
                .Where(kv => !KnownKeys.Contains(kv.Key))
                .ToDictionary(kv => kv.Key, kv => kv.Value),
        };
    }

    // Render a Note back to a .md document. Foreign keys are merged through
    // untouched: first from the note's own carried bag (so imports keep them), then
    // overlaid by `preserve` — the existing file's frontmatter — which wins, since
    // that reflects whatever a sync tool most recently wrote to disk.
    public string Serialize(Note note, IDictionary<string, object?>? preserve = null)
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

        var yaml = _yamlWriter.Serialize(fm).TrimEnd('\n', '\r');
        return $"---\n{yaml}\n---\n\n{note.Body}";
    }

    // ── Disk (crash-safe I/O) ────────────────────────────────────────────────

    // Read a note from disk. Returns null if the file is absent.
    public async Task<Note?> ReadAsync(string path, CancellationToken ct = default)
    {
        if (!File.Exists(path)) return null;
        var content = await WithBackoff(() => File.ReadAllTextAsync(path, ct));
        return Deserialize(content);
    }

    // Atomically persist a note: write a uuid.tmp sibling, fsync, then replace the
    // target in one move. Never leaves a 0-byte .md behind. Foreign frontmatter on
    // the existing file is preserved.
    public async Task WriteAsync(string path, Note note, CancellationToken ct = default)
    {
        var existing = File.Exists(path)
            ? SplitFrontmatter(await WithBackoff(() => File.ReadAllTextAsync(path, ct))).Frontmatter
            : null;

        var content = Serialize(note, existing);

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

        var raw = content.Substring(block.Span.Start, block.Span.Length);
        // Strip the leading/trailing `---` fence lines.
        var lines = raw.Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count > 0 && lines[0].TrimEnd() == "---") lines.RemoveAt(0);
        if (lines.Count > 0 && lines[^1].TrimEnd() == "---") lines.RemoveAt(lines.Count - 1);
        var yamlText = string.Join('\n', lines);

        var body = content.Substring(block.Span.End + 1).TrimStart('\r', '\n');

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
