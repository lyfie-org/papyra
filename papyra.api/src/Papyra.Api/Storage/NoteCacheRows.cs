using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Writes to the disposable NoteCache mirror, shared by the cold-boot diff and the
// vault watcher so both record a note the same way. Rows are keyed by
// (userId, noteId) — never the bare id (see NoteCache).
internal static class NoteCacheRows
{
    // The DB is on disk as well: a locked note's title stays out of it.
    public static string Title(Note note) => note.Secure ? string.Empty : note.Title;

    public static void Upsert(AppDbContext db, NoteCache? existing, string userId, Note note, DateTime mtime)
    {
        if (existing is null)
        {
            db.NoteCache.Add(new NoteCache
            {
                UserId = userId,
                Id = note.Id,
                Title = Title(note),
                Tags = string.Join(' ', note.Tags),
                LastModified = mtime,
            });
        }
        else
        {
            existing.Title = Title(note);
            existing.Tags = string.Join(' ', note.Tags);
            existing.LastModified = mtime;
        }
    }
}
