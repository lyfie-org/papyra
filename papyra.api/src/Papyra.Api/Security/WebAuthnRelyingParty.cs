using System.Net;

namespace Papyra.Api.Security;

/// <summary>The relying party for one WebAuthn ceremony: the rp id and the exact origin.</summary>
public sealed record RelyingParty(string RpId, string Origin);

/// <summary>A reason biometrics cannot work at the address Papyra was opened on.</summary>
public sealed record RelyingPartyProblem(string Code, string Message);

/// <summary>
/// Works out the WebAuthn relying party from the request instead of from one
/// fixed setting.
///
/// Papyra is self-hosted and opened at whatever address the owner uses —
/// localhost, a LAN name, a Tailscale name, a domain. The old fixed
/// <c>WebAuthn:ServerDomain</c> (default <c>localhost</c>) made the browser refuse
/// every other address with "'rp.id' cannot be used with the current origin".
/// The rp id now follows the host the page was loaded from, so a passkey
/// registered at an address works at that address.
///
/// Trust: the browser sets <c>Origin</c>, and the origin is only accepted when its
/// host is the host the request was sent to (or an origin the admin listed in
/// <c>WebAuthn:Origins</c>, for a split front-end). A credential is bound by the
/// authenticator to the rp id it was made for, so a page on any other host can
/// never produce an assertion that verifies here.
/// </summary>
public static class WebAuthnRelyingParty
{
    public static (RelyingParty? Party, RelyingPartyProblem? Problem) Resolve(HttpRequest request, IConfiguration config)
    {
        var originHeader = request.Headers.Origin.ToString();
        var origin = string.IsNullOrEmpty(originHeader)
            ? $"{request.Scheme}://{request.Host}"
            : originHeader;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
            return (null, new RelyingPartyProblem("rp_origin", "Unrecognised origin."));

        var host = uri.Host.ToLowerInvariant();
        var listed = config.GetSection("WebAuthn:Origins").Get<string[]>() ?? [];
        var sameHost = string.Equals(host, request.Host.Host, StringComparison.OrdinalIgnoreCase);
        var allowed = sameHost || listed.Any(o => string.Equals(o.TrimEnd('/'), origin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase));
        if (!allowed)
            return (null, new RelyingPartyProblem("rp_origin", "This address is not allowed to use biometric unlock."));

        // WebAuthn has no rp id for a bare IP address, and browsers only expose it
        // on HTTPS (or localhost). Say so plainly; the PIN works everywhere.
        if (IPAddress.TryParse(host.Trim('[', ']'), out _))
            return (null, new RelyingPartyProblem("rp_ip",
                "Biometric unlock needs Papyra opened by name (like papyra.local or localhost), not by an IP address. Use your PIN here."));
        var isLocal = host == "localhost" || host.EndsWith(".localhost", StringComparison.Ordinal);
        if (uri.Scheme != Uri.UriSchemeHttps && !isLocal)
            return (null, new RelyingPartyProblem("rp_insecure",
                "Biometric unlock needs Papyra served over HTTPS. Use your PIN here."));

        // An admin can name a parent domain so one passkey covers its subdomains.
        var rpId = host;
        var configured = config["WebAuthn:ServerDomain"]?.Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(configured) && (host == configured || host.EndsWith("." + configured, StringComparison.Ordinal)))
            rpId = configured;

        return (new RelyingParty(rpId, $"{uri.Scheme}://{uri.Authority}"), null);
    }
}
