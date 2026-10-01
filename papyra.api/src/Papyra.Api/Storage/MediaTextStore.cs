using System.Text;

namespace Papyra.Api.Storage;

/// <summary>
/// Text read out of an attachment — the words in a picture (OCR) or said in a
/// recording (a transcript) — kept beside its other derived state as
/// <c>users/{uid}/.papyra/media/{name}.ocr.txt</c> / <c>{name}.transcript.txt</c>.
/// <para>
/// Sidecars, not index-only: the search index is a disposable cache and is
/// rebuilt nightly, and re-running OCR/Whisper over a whole library to refill it
/// would take hours. The index folds a note's attachment text into that note's
/// own document (never for a Secure note), so a rebuild keeps it for free.
/// Pruning moves sidecars to the media trash with their file; backups carry them.
/// </para>
/// </summary>
public sealed class MediaTextStore(IConfiguration config, IHostEnvironment env)
{
    public const string Ocr = "ocr";
    public const string Transcript = "transcript";

    /// <summary>Cap per sidecar (and so per attachment in the index): 256 KB of text.</summary>
    public const int MaxChars = 256 * 1024;

    private string Dir(string uid) => PapyraPaths.UserMediaDerivedDir(config, env.ContentRootPath, uid);

    private string? PathFor(string uid, string name, string kind)
    {
        if (kind is not (Ocr or Transcript)) return null;
        if (string.IsNullOrEmpty(name) || name.Length > 255 || name.IndexOfAny(['/', '\\', '\0']) >= 0
            || name is "." or "..") return null;
        return Path.Combine(Dir(uid), $"{name}.{kind}.txt");
    }

    public bool Has(string uid, string name, string kind) =>
        PathFor(uid, name, kind) is { } p && File.Exists(p);

    public string? Read(string uid, string name, string kind)
    {
        var path = PathFor(uid, name, kind);
        if (path is null || !File.Exists(path)) return null;
        try { return File.ReadAllText(path, Encoding.UTF8); }
        catch (IOException) { return null; }
    }

    /// <summary>
    /// Write (or replace) a sidecar atomically. Empty text is recorded too — an
    /// empty file means "looked, found nothing", so the job isn't run again.
    /// </summary>
    public void Write(string uid, string name, string kind, string text)
    {
        var path = PathFor(uid, name, kind) ?? throw new ArgumentException("Bad media name or text kind.");
        Directory.CreateDirectory(Dir(uid));
        var body = text.Length > MaxChars ? text[..MaxChars] : text;
        var tmp = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tmp, body, new UTF8Encoding(false));
            File.Move(tmp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    /// <summary>
    /// All attachment text for a body's references, for the search index. Names
    /// are the body's own references (case-insensitive lookup on disk).
    /// </summary>
    public string ForBody(string uid, string? body)
    {
        if (string.IsNullOrEmpty(body)) return string.Empty;
        var dir = Dir(uid);
        if (!Directory.Exists(dir)) return string.Empty;
        var sb = new StringBuilder();
        foreach (var name in MediaRefParser.Extract(body))
        {
            foreach (var kind in (string[])[Ocr, Transcript])
            {
                var text = Read(uid, name, kind);
                if (string.IsNullOrWhiteSpace(text)) continue;
                if (sb.Length > 0) sb.Append('\n');
                sb.Append(text);
            }
        }
        return sb.ToString();
    }
}
