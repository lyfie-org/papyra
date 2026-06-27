using System.Text.Json;

namespace Papyra.Api.Storage;

// Per-user category registry. A category is just a curated note tag with optional
// colour metadata (Papyra's "promoted tag" model). The registry lives in
// users/{uid}/.papyra/categories.json — UI/organisation state, never the notes
// vault. The notes' own `tags` frontmatter stays the source of truth for which
// note belongs to which category; this file only adds the colour + lets an empty
// category exist before any note uses it. Singleton; atomic writes.
public sealed class CategoryStore
{
    public sealed record Category(string Name, string? Color);

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    private readonly IConfiguration _config;
    private readonly string _contentRoot;

    public CategoryStore(IConfiguration config, IHostEnvironment env)
    {
        _config = config;
        _contentRoot = env.ContentRootPath;
    }

    public List<Category> Read(string userId)
    {
        var path = PapyraPaths.UserCategoriesFile(_config, _contentRoot, userId);
        if (!File.Exists(path)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<Category>>(File.ReadAllText(path)) ?? [];
        }
        catch
        {
            return []; // disposable curation — a bad file just means "no registry yet"
        }
    }

    public void Write(string userId, List<Category> categories)
    {
        var path = PapyraPaths.UserCategoriesFile(_config, _contentRoot, userId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var tmp = Path.Combine(Path.GetDirectoryName(path)!, $"{Guid.NewGuid():N}.tmp");
        File.WriteAllText(tmp, JsonSerializer.Serialize(categories, Json));
        if (File.Exists(path)) File.Replace(tmp, path, destinationBackupFileName: null);
        else File.Move(tmp, path, overwrite: true);
    }

    // Add or recolour a category (case-insensitive match on name).
    public List<Category> Upsert(string userId, string name, string? color)
    {
        var list = Read(userId);
        var idx = list.FindIndex(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
        if (idx >= 0) list[idx] = new Category(list[idx].Name, color ?? list[idx].Color);
        else list.Add(new Category(name, color));
        Write(userId, list);
        return list;
    }

    public List<Category> Remove(string userId, string name)
    {
        var list = Read(userId);
        list.RemoveAll(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
        Write(userId, list);
        return list;
    }
}
