using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.Options;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>
/// Fills in the `oidc` scheme's options from <see cref="InstanceConfigStore"/>
/// instead of from configuration read once at startup.
///
/// The scheme is registered unconditionally so it always exists; whether SSO is
/// actually usable is decided per-request by whether the store holds an
/// authority and client id. That is what lets an admin set SSO up from the
/// Settings UI and have it work immediately — the alternative was editing
/// appsettings.json inside a container and restarting it.
///
/// ASP.NET caches resolved options per scheme in
/// <see cref="IOptionsMonitorCache{TOptions}"/>, so saving new values must evict
/// the cached entry (the admin endpoint does this) or the handler would keep
/// using the previous configuration until the process restarted.
/// </summary>
public sealed class OidcOptionsConfigurator : IConfigureNamedOptions<OpenIdConnectOptions>
{
    /// <summary>
    /// Stand-ins used while SSO is unconfigured, so the scheme's options pass
    /// validation. Unreachable in practice — see the note in Configure.
    /// </summary>
    private const string UnconfiguredAuthority = "https://sso-not-configured.invalid";
    private const string UnconfiguredClientId = "sso-not-configured";

    private readonly InstanceConfigStore _config;

    public OidcOptionsConfigurator(InstanceConfigStore config) => _config = config;

    public void Configure(OpenIdConnectOptions options) => Configure(Options.DefaultName, options);

    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name != "oidc") return;

        // Options are built synchronously by the auth stack, so the store must
        // already be warm — Program warms it during startup before the first
        // request can arrive.
        _config.EnsureLoadedAsync().GetAwaiter().GetResult();

        var authority = _config.GetOrEmpty(OidcKeys.Authority);
        var clientId = _config.GetOrEmpty(OidcKeys.ClientId);

        // OpenIdConnectOptions.Validate() throws on an empty Authority/ClientId,
        // and it runs whenever the options are resolved — which happens on
        // ordinary requests, not just SSO ones. Since the scheme is registered
        // unconditionally, an unconfigured instance would 500 on every request.
        // Placeholders keep validation happy; they are never reachable because
        // `/api/auth/login/sso` refuses unless SsoConfigured() passes, so no
        // request can ever be sent to this address.
        options.Authority = authority.Length > 0 ? authority : UnconfiguredAuthority;
        options.ClientId = clientId.Length > 0 ? clientId : UnconfiguredClientId;
        options.ClientSecret = _config.Get(OidcKeys.ClientSecret);
    }
}
