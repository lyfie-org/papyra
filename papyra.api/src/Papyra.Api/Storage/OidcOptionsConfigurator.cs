using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.Options;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>
/// Fills in each SSO provider's OIDC scheme options from
/// <see cref="InstanceConfigStore"/> (see <see cref="SsoProviders"/>) instead of
/// from configuration read once at startup.
///
/// Schemes are "oidc" (the original single provider, always registered) and
/// "oidc-{id}" for each provider added in Settings → SSO. Whether a provider is
/// usable is decided per request by <see cref="SsoProvider.Ready"/>; that is what
/// lets an admin set SSO up from the UI and have it work immediately.
///
/// ASP.NET caches resolved options per scheme in
/// <see cref="IOptionsMonitorCache{TOptions}"/>, so saving new values must evict
/// the cached entries (<see cref="SsoProviders.SyncSchemesAsync"/> does) or the
/// handler would keep using the previous configuration until a restart.
/// </summary>
public sealed class OidcOptionsConfigurator : IConfigureNamedOptions<OpenIdConnectOptions>
{
    /// <summary>
    /// Stand-ins used while a scheme has no provider behind it, so its options
    /// pass validation. Unreachable in practice — see the note in Configure.
    /// </summary>
    private const string UnconfiguredAuthority = "https://sso-not-configured.invalid";
    private const string UnconfiguredClientId = "sso-not-configured";

    private readonly InstanceConfigStore _config;
    private readonly SsoHooks _hooks;

    public OidcOptionsConfigurator(InstanceConfigStore config, SsoHooks hooks)
    {
        _config = config;
        _hooks = hooks;
    }

    public void Configure(OpenIdConnectOptions options) => Configure(Options.DefaultName, options);

    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name is null || SsoProviders.IdFromScheme(name) is not { } id) return;

        // Options are built synchronously by the auth stack, so the store must
        // already be warm — Program warms it during startup before the first
        // request can arrive.
        _config.EnsureLoadedAsync().GetAwaiter().GetResult();
        var provider = SsoProviders.Read(_config).FirstOrDefault(p => p.Id == id);

        // OpenIdConnectOptions.Validate() throws on an empty Authority/ClientId,
        // and it runs whenever the options are resolved — which happens on
        // ordinary requests, not just SSO ones. Placeholders keep validation
        // happy; they are never reachable because `/api/auth/login/sso/{id}`
        // refuses a provider that isn't Ready, so no request is sent there.
        options.Authority = provider is { Authority.Length: > 0 } ? provider.Authority : UnconfiguredAuthority;
        options.ClientId = provider is { ClientId.Length: > 0 } ? provider.ClientId : UnconfiguredClientId;
        options.ClientSecret = provider?.ClientSecret;
        options.CallbackPath = SsoProviders.CallbackPath(id);

        options.ResponseType = "code";
        // The external identity is exchanged for our own cookie session, so the rest
        // of the app keeps reading the internal UserId claim as before.
        options.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        options.GetClaimsFromUserInfoEndpoint = true;
        options.SaveTokens = false;
        if (!options.Scope.Contains("email")) options.Scope.Add("email");
        if (!options.Scope.Contains("profile")) options.Scope.Add("profile");
        options.Events = _hooks.Events;
    }
}
