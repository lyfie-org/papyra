using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Adopts a .md file another tool created (Obsidian, a text editor, a Syncthing
// peer) with no `id:` in its frontmatter, so it becomes an ordinary note instead
// of an id-less ghost in the list that search can't find and a restart drops.
// The watcher and the cold-boot walk both come through here, so a file gets the
// same id whichever of them sees it first. (Its title needs no adopting —
// ReadAsync names any file without a `title:` key after its first heading or
// its file name.)
//
// The id is written back into the file. Shares, comments, history, links and
// the grid order all key on it, so it has to outlive the things a file name
// doesn't: Papyra renaming the file after its title, or the user renaming it in
// Obsidian. Kept in memory only, the next rename would orphan all of them. The
// write is as small as it can be — one `id:` line, foreign keys and body
// byte-for-byte, mtime restored (see MarkdownStorageService.TryStampIdAsync) —
// and marked in the WriteRing so the watcher doesn't take it for an edit.
//
// The id is a name-based GUID of the file's path in the vault — Papyra's own
// ids are GUIDs — rather than a slug of the file name: a slug id ("recipes" for
// Recipes.md) would make NoteFileNamer take the name for one Papyra chose and
// rename a file the user named. Deterministic, so the id holds even where the
// write-back can't happen (a read-only vault, YAML too broken to touch safely)
// as long as the file stays put, and an editor that saves a stale buffer over
// the stamped file gets the same id back on the next pass.
public sealed class ForeignNoteAdopter
{
    // Namespace for the name-based ids, fixed forever: changing it would re-key
    // every note adopted but not yet stamped.
    private static readonly Guid Namespace = new("6a1f3c2e-8b4d-4e9a-9c51-2f7d0b6e4a83");

    private readonly MarkdownStorageService _storage;
    private readonly WriteRing _writeRing;
    private readonly ILogger _logger;

    public ForeignNoteAdopter(MarkdownStorageService storage, WriteRing writeRing, ILogger<ForeignNoteAdopter>? logger = null)
    {
        _storage = storage;
        _writeRing = writeRing;
        _logger = logger ?? (ILogger)NullLogger.Instance;
    }

    public static bool NeedsId(Note note) => string.IsNullOrWhiteSpace(note.Id);

    /// <summary>
    /// The id for the id-less file at <paramref name="path"/>: a name-based GUID
    /// of its path relative to <paramref name="notesDir"/>, moved along a fixed
    /// sequence until <paramref name="isTaken"/> lets it go.
    /// </summary>
    public static string DeriveId(string notesDir, string path, Func<string, bool> isTaken)
    {
        var rel = Path.GetRelativePath(notesDir, path).Replace('\\', '/');
        for (var n = 1; ; n++)
        {
            var id = NameGuid(n == 1 ? rel : $"{rel}#{n}").ToString();
            if (PathGuard.IsValidNoteId(id) && !isTaken(id)) return id;
        }
    }

    /// <summary>
    /// Give <paramref name="note"/>, read from an id-less file, its id and write
    /// that id into the file. <paramref name="preferredId"/> — the id the vault
    /// already knew this path by — wins while it is free, so a tool that strips
    /// the key again doesn't re-key the note. Returns false (changing nothing)
    /// when the note already has an id. A failed write-back is logged, never
    /// thrown: the note is still adopted in memory, under the same id.
    /// </summary>
    public async Task<bool> AdoptAsync(
        string notesDir, string path, Note note, Func<string, bool> isTaken,
        string? preferredId = null, CancellationToken ct = default)
    {
        if (!NeedsId(note)) return false;

        note.Id = !string.IsNullOrWhiteSpace(preferredId) && PathGuard.IsValidNoteId(preferredId) && !isTaken(preferredId)
            ? preferredId
            : DeriveId(notesDir, path, isTaken);

        try
        {
            _writeRing.Mark(path);
            var stamped = await _storage.TryStampIdAsync(path, note.Id, ct);
            _writeRing.Mark(path); // sliding window: cover the replace + mtime restore
            if (stamped)
                _logger.LogInformation("Adopted {Path} as note {Id}", path, note.Id);
            else
                _logger.LogInformation("Adopted {Path} as note {Id} (id not written back)", path, note.Id);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Adopted {Path} as note {Id}, but could not write the id into it", path, note.Id);
        }
        return true;
    }

    // RFC 4122 version-5 (SHA-1, name-based) GUID.
    private static Guid NameGuid(string name)
    {
        var ns = Namespace.ToByteArray(bigEndian: true);
        var bytes = Encoding.UTF8.GetBytes(name);
        var input = new byte[ns.Length + bytes.Length];
        ns.CopyTo(input, 0);
        bytes.CopyTo(input, ns.Length);
        var hash = SHA1.HashData(input);
        var g = hash[..16];
        g[6] = (byte)((g[6] & 0x0F) | 0x50);
        g[8] = (byte)((g[8] & 0x3F) | 0x80);
        return new Guid(g, bigEndian: true);
    }
}
