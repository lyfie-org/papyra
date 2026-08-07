using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Storage;

// Shared definition of the trash-retention setting, read by both the settings
// endpoints and the purge sweep. Days: -1 = keep forever, 0 = purge immediately,
// else N days. Default is 30 (a common industry standard, e.g. Drive/OneDrive).
public static class TrashRetention
{
    public const string Key = "trash.retentionDays";
    public const int DefaultDays = 30;
    public static readonly int[] Allowed = [-1, 0, 3, 7, 30, 60];

    public static async Task<int> ReadDays(AppDbContext db, CancellationToken ct = default)
    {
        var row = await db.Settings.FirstOrDefaultAsync(s => s.Key == Key, ct);
        return row?.Value is { } v && int.TryParse(v, out var d) ? d : DefaultDays;
    }
}
