using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

/// <summary>
/// Rebuilds search (and the note cache beside it) from the files on disk — the
/// .md files are the authority, and both are disposable mirrors of them.
///
/// One implementation for every caller: the "Rebuild search" job on the Jobs
/// screen (every account), the end of an Obsidian/Keep import (the importer's
/// account), and the per-user API endpoint.
/// </summary>
public sealed class SearchRebuilder
{
    private readonly IServiceScopeFactory _scopes;
    private readonly MarkdownStorageService _storage;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly VaultObserverOptions _vault;

    public SearchRebuilder(
        IServiceScopeFactory scopes,
        MarkdownStorageService storage,
        VaultState state,
        SearchIndexService search,
        VaultObserverOptions vault)
    {
        _scopes = scopes;
        _storage = storage;
        _state = state;
        _search = search;
        _vault = vault;
    }

    /// <summary>Re-read one account's notes into search. Returns how many notes were indexed.</summary>
    public async Task<int> RebuildUserAsync(string uid, CancellationToken ct)
    {
        var notesDir = _vault.UserNotesDir(uid);
        Directory.CreateDirectory(notesDir);
        var scanned = new List<(Note Note, DateTime Mtime)>();
        foreach (var path in Directory.EnumerateFiles(notesDir, "*.md", SearchOption.AllDirectories))
        {
            if (ConflictDetector.IsConflict(Path.GetFileName(path))) continue; // not a note
            var note = await _storage.ReadAsync(path, ct);
            if (note is null || string.IsNullOrEmpty(note.Id)) continue;
            _state.Upsert(uid, path, note);
            scanned.Add((note, File.GetLastWriteTimeUtc(path)));
        }

        _search.RebuildUser(uid, scanned.Select(s => s.Note)); // drop only this tenant's docs

        // Refresh the caller's cache rows (disposable mirror, keyed by tenant + note
        // id). The UserId filter is load-bearing, not decorative: without it a
        // rebuild deleted every tenant's row for any id this vault happened to share
        // — and "Inbox" is shared by every user who has ever been @mentioned.
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var ids = scanned.Select(s => s.Note.Id).ToHashSet(StringComparer.Ordinal);
        db.NoteCache.RemoveRange(db.NoteCache.Where(r => r.UserId == uid && ids.Contains(r.Id)));
        db.NoteCache.AddRange(scanned.Select(s => new NoteCache
        {
            UserId = uid,
            Id = s.Note.Id,
            Title = s.Note.Title,
            Tags = string.Join(' ', s.Note.Tags),
            LastModified = s.Mtime,
        }));
        await db.SaveChangesAsync(ct);
        return scanned.Count;
    }

    /// <summary>Every account, one after another. Returns the total notes indexed.</summary>
    public async Task<int> RebuildAllAsync(CancellationToken ct)
    {
        List<int> ids;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            ids = [.. db.Users.Select(u => u.Id)];
        }
        var total = 0;
        foreach (var id in ids)
            total += await RebuildUserAsync(id.ToString(), ct);
        return total;
    }
}
