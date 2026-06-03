using System.Text.Json;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// Manages role definitions at {storageRoot}/.system/roles/{roleName}.json.
// Ensures admin and member defaults exist on first access.
public sealed class RoleService
{
    public const string AdminRole  = "admin";
    public const string MemberRole = "member";
    public const string ViewerRole = "viewer";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    private readonly string _rolesDir;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public RoleService(IConfiguration configuration)
    {
        var storageRoot = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _rolesDir = Path.Combine(storageRoot, ".system", "roles");
        Directory.CreateDirectory(_rolesDir);
    }

    public async Task EnsureDefaultsAsync()
    {
        var adminPath  = RolePath(AdminRole);
        var memberPath = RolePath(MemberRole);

        if (!File.Exists(adminPath))
            await SaveRoleAsync(new RoleModel
            {
                Name                 = AdminRole,
                MaxNotesAllowed      = -1,   // -1 = unlimited
                AllowFileUploads     = true,
                AttachmentSizeLimitMB = 100,
            });

        if (!File.Exists(memberPath))
            await SaveRoleAsync(new RoleModel
            {
                Name                 = MemberRole,
                MaxNotesAllowed      = 200,
                AllowFileUploads     = true,
                AttachmentSizeLimitMB = 16,
            });

        var viewerPath = RolePath(ViewerRole);
        if (!File.Exists(viewerPath))
            await SaveRoleAsync(new RoleModel
            {
                Name                 = ViewerRole,
                MaxNotesAllowed      = 0,   // viewers cannot create notes
                AllowFileUploads     = false,
                AttachmentSizeLimitMB = 0,
            });
    }

    public async Task<RoleModel?> GetRoleAsync(string roleName)
    {
        var path = RolePath(roleName);
        if (!File.Exists(path)) return null;

        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return await JsonSerializer.DeserializeAsync<RoleModel>(fs, JsonOpts);
        }
        finally { _lock.Release(); }
    }

    public async Task SaveRoleAsync(RoleModel role)
    {
        var path = RolePath(role.Name);
        await _lock.WaitAsync();
        try
        {
            await using var fs = new FileStream(
                path, FileMode.Create, FileAccess.Write, FileShare.None);
            await JsonSerializer.SerializeAsync(fs, role, JsonOpts);
        }
        finally { _lock.Release(); }
    }

    public async Task<List<RoleModel>> ListRolesAsync()
    {
        var result = new List<RoleModel>();
        foreach (var file in Directory.EnumerateFiles(_rolesDir, "*.json"))
        {
            await _lock.WaitAsync();
            try
            {
                await using var fs = new FileStream(
                    file, FileMode.Open, FileAccess.Read, FileShare.Read);
                var role = await JsonSerializer.DeserializeAsync<RoleModel>(fs, JsonOpts);
                if (role is not null) result.Add(role);
            }
            finally { _lock.Release(); }
        }
        return result;
    }

    private string RolePath(string roleName) =>
        Path.Combine(_rolesDir, $"{roleName.ToLowerInvariant()}.json");
}
