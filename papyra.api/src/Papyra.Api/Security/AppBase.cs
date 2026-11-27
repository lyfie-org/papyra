using System.Text.RegularExpressions;

namespace Papyra.Api.Security;

public sealed partial record AppBase(string Path)
{
    public static AppBase Root { get; } = new(string.Empty);

    public bool IsRoot => Path.Length == 0;

    [GeneratedRegex(@"^(/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$")]
    private static partial Regex Valid();

    public static AppBase From(string? raw) => new(Normalize(raw));

    public static string Normalize(string? raw)
    {
        var value = raw?.Trim() ?? string.Empty;
        if (value.Length == 0 || value == "/") return string.Empty;
        if (!value.StartsWith('/')) value = "/" + value;
        value = value.TrimEnd('/');
        if (!Valid().IsMatch(value))
            throw new InvalidOperationException(
                $"PAPYRA_BASE_PATH \"{raw}\" is not a usable path. Write it like /papyra: letters, digits, '-', '_', '.', '~' and '/' only.");
        return value;
    }

    public string Prefix(string rootRelative) => Path + rootRelative;
}

public static class AppBaseExtensions
{
    public static string BasePath(this HttpContext http) =>
        http.RequestServices?.GetService<AppBase>()?.Path ?? string.Empty;

    public static string PublicOrigin(this HttpContext http) =>
        $"{http.Request.Scheme}://{http.Request.Host}{http.BasePath()}";
}
