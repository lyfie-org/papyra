using Papyra.Api.Storage;

namespace Papyra.Api.Features;

/// <summary>
/// <c>/api/admin/update</c> — what the sidebar's "update available" icon and its popup read.
/// Admins only: they are the ones who can pull a newer image. See <c>Storage/UpdateCheck.cs</c> for
/// the whole of the daily check: one plain request to GitHub, nothing about this install.
/// </summary>
public static class UpdateEndpoints
{
    public static void MapUpdates(this WebApplication app)
    {
        var g = app.MapGroup("/api/admin/update").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

        g.MapGet("/", (UpdateStatus status) => Describe(status))
            .WithSummary("Is a newer Papyra out?")
            .WithDescription("The release this server runs, and the newest one the daily check on GitHub has heard of.");
    }

    private static object Describe(UpdateStatus s) => new
    {
        enabled = s.Enabled,
        turnedOff = s.TurnedOff,
        current = s.Current,
        available = s.Available,
        latest = s.Latest?.Version,
        url = s.Latest?.Url,
        checkedUtc = s.CheckedUtc,
    };
}
