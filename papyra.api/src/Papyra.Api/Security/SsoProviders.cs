using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.Options;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>One identity provider on the sign-in page (Settings → SSO).</summary>
public sealed class SsoProvider
{
    /// <summary>URL-safe slug: the callback is /signin-oidc/{id}. "oidc" is the original single provider.</summary>
    public string Id { get; set; } = string.Empty;
    /// <summary>authentik | keycloak | google | entra | other — which setup steps and default icon.</summary>
    public string Kind { get; set; } = "other";
    public string DisplayName { get; set; } = string.Empty;
    public string Authority { get; set; } = string.Empty;
    public string ClientId { get; set; } = string.Empty;
    public string? ClientSecret { get; set; }
    public bool Enabled { get; set; }
    /// <summary>A built-in icon key; null = the Kind's own.</summary>
    public string? Icon { get; set; }
    /// <summary>An uploaded icon as a data: URL (wins over <see cref="Icon"/>).</summary>
    public string? IconData { get; set; }
    /// <summary>Tooltip on the sign-in page; null = "Continue with {DisplayName}".</summary>
    public string? HoverText { get; set; }

    public bool Ready => Enabled && Authority.Length > 0 && ClientId.Length > 0;
}

/// <summary>Carries the shared OIDC event handlers (defined in Program) to every provider's scheme.</summary>
public sealed record SsoHooks(OpenIdConnectEvents Events);

/// <summary>
/// The configured providers, stored as one JSON value in the instance config.
///
/// Each provider is its own OIDC authentication scheme with its own callback
/// path, registered and unregistered at runtime as the admin edits the list — no
/// restart. The original single-provider settings (`oidc.*` keys) read as a
/// provider with id "oidc", keeping its old callback `/signin-oidc`, so an
/// upgrade doesn't break a redirect URI already registered at the IdP.
/// </summary>
public static partial class SsoProviders
{
    public const string ProvidersKey = "sso.providers";
    public const string DisplayKey = "sso.display";
    public const string LegacyId = "oidc";
    private const string SchemePrefix = "oidc-";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static List<SsoProvider> Read(InstanceConfigStore config)
    {
        var raw = config.Get(ProvidersKey);
        if (!string.IsNullOrWhiteSpace(raw))
        {
            try { return JsonSerializer.Deserialize<List<SsoProvider>>(raw, Json) ?? []; }
            catch (JsonException) { return []; }
        }
        if (!config.Has(OidcKeys.Authority) && !config.Has(OidcKeys.ClientId)) return [];
        var authority = config.GetOrEmpty(OidcKeys.Authority);
        return
        [
            new SsoProvider
            {
                Id = LegacyId,
                Kind = GuessKind(authority),
                DisplayName = config.GetOrEmpty(OidcKeys.DisplayName) is { Length: > 0 } n ? n : "SSO",
                Authority = authority,
                ClientId = config.GetOrEmpty(OidcKeys.ClientId),
                ClientSecret = config.Get(OidcKeys.ClientSecret),
                Enabled = config.GetBool(OidcKeys.Enabled),
            },
        ];
    }

    /// <summary>Persist the list; the legacy single-provider keys are cleared so they can't resurface.</summary>
    public static Task WriteAsync(InstanceConfigStore config, List<SsoProvider> providers, CancellationToken ct) =>
        config.SetAsync(new Dictionary<string, string?>
        {
            [ProvidersKey] = JsonSerializer.Serialize(providers, Json),
            [OidcKeys.Enabled] = null,
            [OidcKeys.Authority] = null,
            [OidcKeys.ClientId] = null,
            [OidcKeys.ClientSecret] = null,
            [OidcKeys.DisplayName] = null,
        }, ct);

    /// <summary>"buttons" (a full-width button per provider) or "icons" (a row of round icons).</summary>
    public static string Display(InstanceConfigStore config) =>
        config.Get(DisplayKey) == "icons" ? "icons" : "buttons";

    public static string Scheme(string id) => id == LegacyId ? "oidc" : SchemePrefix + id;

    public static string? IdFromScheme(string scheme) =>
        scheme == "oidc" ? LegacyId : scheme.StartsWith(SchemePrefix, StringComparison.Ordinal) ? scheme[SchemePrefix.Length..] : null;

    public static string CallbackPath(string id) => id == LegacyId ? "/signin-oidc" : $"/signin-oidc/{id}";

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonSlug();

    /// <summary>A fresh id from the provider's name: "Acme SSO" → "acme-sso", suffixed until unique.</summary>
    public static string NewId(string name, IEnumerable<string> taken)
    {
        var used = taken.ToHashSet(StringComparer.Ordinal);
        used.Add(LegacyId); // reserved for the original provider's callback
        var slug = NonSlug().Replace(name.ToLowerInvariant(), "-").Trim('-');
        if (slug.Length > 24) slug = slug[..24].Trim('-');
        if (slug.Length == 0) slug = "sso";
        var candidate = slug;
        for (var n = 2; used.Contains(candidate); n++) candidate = $"{slug}-{n}";
        return candidate;
    }

    public static string GuessKind(string authority)
    {
        var a = authority.ToLowerInvariant();
        if (a.Contains("/application/o/")) return "authentik";
        if (a.Contains("/realms/")) return "keycloak";
        if (a.Contains("accounts.google.com")) return "google";
        if (a.Contains("login.microsoftonline.com")) return "entra";
        return "other";
    }

    /// <summary>
    /// Make the registered OIDC schemes match the provider list, and drop every
    /// cached options object so edited settings take effect on the next request.
    /// The static "oidc" scheme always stays (registered at startup).
    /// </summary>
    public static async Task SyncSchemesAsync(
        IAuthenticationSchemeProvider schemes, IOptionsMonitorCache<OpenIdConnectOptions> cache, IEnumerable<SsoProvider> providers)
    {
        var wanted = providers.Select(p => Scheme(p.Id)).ToHashSet(StringComparer.Ordinal);
        foreach (var scheme in await schemes.GetAllSchemesAsync())
        {
            if (scheme.HandlerType != typeof(OpenIdConnectHandler)) continue;
            cache.TryRemove(scheme.Name);
            if (scheme.Name != "oidc" && !wanted.Contains(scheme.Name)) schemes.RemoveScheme(scheme.Name);
        }
        foreach (var name in wanted)
        {
            if (await schemes.GetSchemeAsync(name) is null)
                schemes.AddScheme(new AuthenticationScheme(name, name, typeof(OpenIdConnectHandler)));
        }
    }
}
