using System.Text.Json;

namespace Papyra.Api.Storage;

// Per-user manual note ordering. Drag positions are UI state, so they live in
// users/{uid}/.papyra/order.json — never the notes vault. Each entry pins a note
// to a fractional sort `Key`; `SetAt` records the note's mtime (epoch ms) at drag
// time so the client can let a later edit override the manual position (edit always
// bumps a note to the top). Disposable: a missing/garbage file just means "no
// manual order yet". Registered as a singleton; writes are atomic (tmp→replace).
public sealed class OrderStore
{
    public sealed record Entry(double Key, long SetAt);

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    private readonly IConfiguration _config;
    private readonly string _contentRoot;

    public OrderStore(IConfiguration config, IHostEnvironment env)
    {
        _config = config;
        _contentRoot = env.ContentRootPath;
    }

    public Dictionary<string, Entry> Read(string userId)
    {
        var path = PapyraPaths.UserOrderFile(_config, _contentRoot, userId);
        if (!File.Exists(path)) return new(StringComparer.Ordinal);
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, Entry>>(File.ReadAllText(path))
                   ?? new(StringComparer.Ordinal);
        }
        catch
        {
            return new(StringComparer.Ordinal); // graceful ignorance — order is disposable
        }
    }

    public void Write(string userId, Dictionary<string, Entry> entries)
    {
        var path = PapyraPaths.UserOrderFile(_config, _contentRoot, userId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var tmp = Path.Combine(Path.GetDirectoryName(path)!, $"{Guid.NewGuid():N}.tmp");
        File.WriteAllText(tmp, JsonSerializer.Serialize(entries, Json));
        if (File.Exists(path)) File.Replace(tmp, path, destinationBackupFileName: null);
        else File.Move(tmp, path, overwrite: true);
    }
}
