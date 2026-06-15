namespace Papyra.Api.Models;

// Generic key/value store for app-level settings (cache — filesystem is authority).
public class AppSetting
{
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
}
