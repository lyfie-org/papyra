using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Api.Endpoints;

public static class UserEndpoints
{
    public static void Map(WebApplication app)
    {
        // ── GET /api/user/settings ────────────────────────────────────────────
        app.MapGet("/api/user/settings", async (UserSettingsService settings, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name ?? string.Empty;
            return Results.Ok(await settings.GetSettingsAsync(username));
        })
        .RequireAuthorization()
        .WithName("GetUserSettings")
        .WithSummary("Get persisted user preferences")
        .WithTags("User");

        // ── PUT /api/user/settings ────────────────────────────────────────────
        app.MapPut("/api/user/settings",
            async (UpdateSettingsRequest req, UserSettingsService settings, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name ?? string.Empty;
            var current  = await settings.GetSettingsAsync(username);

            if (req.Theme              is not null) current.Theme             = req.Theme;
            if (req.EditorPadding      is not null) current.EditorPadding     = req.EditorPadding;
            if (req.SidebarLayout      is not null) current.SidebarLayout     = req.SidebarLayout;
            if (req.ViewMode           is not null) current.ViewMode          = req.ViewMode;
            if (req.PinnedSharedNotes  is not null) current.PinnedSharedNotes = req.PinnedSharedNotes;

            await settings.SaveSettingsAsync(username, current);
            return Results.Ok(current);
        })
        .RequireAuthorization()
        .WithName("UpdateUserSettings")
        .WithSummary("Update persisted user preferences")
        .WithTags("User");

        // ── GET /api/user/stats ───────────────────────────────────────────────
        app.MapGet("/api/user/stats", (NoteWatcherService watcher, HttpContext ctx) =>
        {
            var username = ctx.User.Identity?.Name ?? string.Empty;

            var myNotes = watcher.Notes.Values
                .Where(n => n.Owner.Equals(username, StringComparison.OrdinalIgnoreCase))
                .ToList();

            var active   = myNotes.Count(n => !n.Archived && !n.Deleted);
            var archived = myNotes.Count(n => n.Archived && !n.Deleted);
            var trash    = myNotes.Count(n => n.Deleted);

            // Word count across all active notes — reads body from disk (stats endpoint, not hot path)
            var wordCount = myNotes
                .Where(n => !n.Archived && !n.Deleted)
                .Sum(n => CountWords(watcher.ReadFullNote(n.Id)?.Content ?? string.Empty));

            return Results.Ok(new { active, archived, trash, wordCount });
        })
        .RequireAuthorization()
        .WithName("GetUserStats")
        .WithSummary("Count of active/archived/deleted notes and total word count")
        .WithTags("User");
    }

    private static int CountWords(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return 0;
        var count = 0;
        var inWord = false;
        foreach (var c in text)
        {
            if (char.IsWhiteSpace(c)) { inWord = false; }
            else if (!inWord)          { inWord = true; count++; }
        }
        return count;
    }
}

record UpdateSettingsRequest(
    string?       Theme,
    string?       EditorPadding,
    string?       SidebarLayout,
    string?       ViewMode,
    List<string>? PinnedSharedNotes);
