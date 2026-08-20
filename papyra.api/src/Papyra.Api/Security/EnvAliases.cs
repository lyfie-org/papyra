namespace Papyra.Api.Security;

/// <summary>
/// Plain-English environment variable names, mapped onto the configuration keys
/// the app actually reads.
///
/// .NET's own convention spells a nested key with a double underscore —
/// `Papyra__AllowInsecureCookies`, `Cors__AllowedOrigins__0`. That is fine for a
/// .NET developer and hostile to everyone else running the container: the casing
/// is load-bearing, the doubled underscore looks like a typo, and a list has to
/// be written one indexed variable per entry. Getting any of it subtly wrong
/// produces no error at all — the setting is simply ignored, which is the worst
/// possible failure for something a person only touches once.
///
/// So this accepts the obvious spelling instead. `PAPYRA_ALLOW_INSECURE_COOKIES`
/// is what somebody would guess, and lists are comma-separated the way every
/// other container image does them.
///
/// The .NET spellings keep working. This layer is registered *after* the
/// environment provider and only fills keys that are still empty, so anything
/// set the official way wins and existing deployments are untouched.
/// </summary>
public static class EnvAliases
{
    /// <summary>Friendly variable → the configuration key it feeds. Single values.</summary>
    private static readonly (string Env, string Key)[] Scalars =
    [
        ("PAPYRA_DATA_DIR", "Papyra:DataDir"),
        ("PAPYRA_ALLOW_INSECURE_COOKIES", "Papyra:AllowInsecureCookies"),
        ("PAPYRA_OLLAMA_URL", "Ollama:BaseUrl"),
        ("PAPYRA_WEBAUTHN_DOMAIN", "WebAuthn:ServerDomain"),
        ("PAPYRA_WHISPER_MODEL_PATH", "Whisper:ModelPath"),
        ("PAPYRA_OCR_TESSDATA_PATH", "Ocr:TessDataPath"),
    ];

    /// <summary>
    /// Friendly variable → the configuration key it feeds, for lists. Written
    /// comma-separated and expanded to the `Key:0`, `Key:1`, … shape .NET binds
    /// an array from. Writing one comma-joined string into `Cors__AllowedOrigins__0`
    /// by hand is an easy mistake and a silent one: it becomes a single array
    /// entry equal to the whole literal string, matching nothing, ever.
    /// </summary>
    private static readonly (string Env, string Key)[] Lists =
    [
        ("PAPYRA_ALLOWED_ORIGINS", "Cors:AllowedOrigins"),
        ("PAPYRA_TRUSTED_PROXIES", "Papyra:TrustedProxies"),
        ("PAPYRA_WEBAUTHN_ORIGINS", "WebAuthn:Origins"),
    ];

    /// <summary>
    /// Read the friendly variables and return the configuration pairs they imply.
    /// A variable that is unset, or blank, contributes nothing — an empty string
    /// is somebody clearing a value, not selecting one.
    /// </summary>
    public static Dictionary<string, string?> Resolve(IDictionary<string, string?> environment)
    {
        var resolved = new Dictionary<string, string?>();

        foreach (var (env, key) in Scalars)
        {
            if (Value(environment, env) is { } value) resolved[key] = value;
        }

        foreach (var (env, key) in Lists)
        {
            if (Value(environment, env) is not { } raw) continue;
            var items = raw
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToArray();
            for (var i = 0; i < items.Length; i++) resolved[$"{key}:{i}"] = items[i];
        }

        return resolved;
    }

    private static string? Value(IDictionary<string, string?> environment, string name)
        => environment.TryGetValue(name, out var v) && !string.IsNullOrWhiteSpace(v)
            ? v.Trim()
            : null;

    /// <summary>
    /// Current process environment, in the shape <see cref="Resolve"/> wants.
    /// </summary>
    public static Dictionary<string, string?> FromProcess()
    {
        var map = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string name) map[name] = entry.Value as string;
        }
        return map;
    }
}
