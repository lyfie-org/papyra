using System.Net;
using System.Net.Sockets;

namespace Papyra.Api.Storage;

/// <summary>Thrown when <see cref="OutboundPolicy"/> refuses a connection, so callers can tell it from a network error.</summary>
public sealed class OutboundBlockedException()
    : HttpRequestException("Papyra is not allowed to connect to that address.");

/// <summary>Where an address sits, as far as sending things to it goes.</summary>
public enum AddressClass
{
    /// <summary>The open internet.</summary>
    Public,
    /// <summary>A home or office network (10.x, 192.168.x, Tailscale's 100.x, unique-local IPv6). Reachable only when the admin allows the host.</summary>
    Private,
    /// <summary>Never reachable, whatever anyone allows: this machine itself, link-local (cloud metadata), multicast, reserved.</summary>
    Never,
}

/// <summary>
/// The rules for Papyra connecting to a server someone typed in — an ntfy server, later a Discord or
/// Telegram endpoint, a Connection. They are the web archiver's anti-SSRF rules, shared, plus one
/// deliberate exception: the admin can list hosts on their own network that may be reached.
///
/// A name or address is checked <em>when the connection is made</em>, and the socket goes to the address
/// that was checked, so a name that answered with a public address a moment ago can't be re-pointed at
/// the network (DNS rebinding). Redirects are never followed. Only the web archiver, which fetches
/// addresses strangers can influence, stays strictly public-only and ignores the admin's list.
/// </summary>
public sealed class OutboundPolicy
{
    /// <summary>The setting holding the admin's list, one host or address per line.</summary>
    public const string AllowedHostsKey = "outbound.allowedHosts";
    public const int MaxAllowedHosts = 50;

    /// <summary>Why a server address is refused (see <see cref="CheckUrlAsync"/>).</summary>
    public static class Problems
    {
        public const string NotAUrl = "not_a_url";
        public const string NeedsHttps = "needs_https";
        public const string Blocked = "blocked";
        public const string HostNotAllowed = "host_not_allowed";
        public const string Unresolvable = "unresolvable";
    }

    private readonly InstanceConfigStore _config;
    private readonly bool _allowLoopback;
    private readonly Lazy<HttpClient> _client;

    public OutboundPolicy(InstanceConfigStore config) : this(config, allowLoopback: false) { }

    // Tests need a server on this machine; nothing outside the test project can ask for this.
    internal OutboundPolicy(InstanceConfigStore config, bool allowLoopback)
    {
        _config = config;
        _allowLoopback = allowLoopback;
        _client = new Lazy<HttpClient>(BuildClient);
    }

    /// <summary>
    /// A client that follows the rules above: no redirects, a short connect timeout, and the address
    /// check at connect time. Shared — don't dispose it, and don't change its default headers.
    /// </summary>
    public HttpClient Client => _client.Value;

    private HttpClient BuildClient()
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AutomaticDecompression = DecompressionMethods.All,
            ConnectCallback = ConnectAsync,
        };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Papyra");
        return client;
    }

    // ── Addresses ───────────────────────────────────────────────────────────────

    public static AddressClass Classify(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || IPAddress.Any.Equals(ip) || IPAddress.IPv6Any.Equals(ip)) return AddressClass.Never;

        var b = ip.GetAddressBytes();
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            if (b[0] is 0 or 127) return AddressClass.Never;                 // "this" network, loopback
            if (b[0] == 169 && b[1] == 254) return AddressClass.Never;       // link-local, incl. 169.254.169.254 (cloud metadata)
            if (b[0] == 100 && b[1] == 100 && b[2] == 100 && b[3] == 200) return AddressClass.Never; // Alibaba metadata, inside the CGNAT range
            if (b[0] >= 224) return AddressClass.Never;                      // multicast and reserved
            if (b[0] == 10) return AddressClass.Private;
            if (b[0] == 172 && b[1] is >= 16 and <= 31) return AddressClass.Private;
            if (b[0] == 192 && b[1] == 168) return AddressClass.Private;
            if (b[0] == 100 && b[1] is >= 64 and <= 127) return AddressClass.Private; // CGNAT, e.g. Tailscale
            return AddressClass.Public;
        }

        if (ip.IsIPv6LinkLocal || ip.IsIPv6Multicast) return AddressClass.Never;
        // AWS's IPv6 metadata address, inside the unique-local range.
        if (b[0] == 0xfd && b[1] == 0x00 && b[2] == 0x0e && b[3] == 0xc2 && b[15] == 0x54) return AddressClass.Never;
        if (ip.IsIPv6SiteLocal || (b[0] & 0xfe) == 0xfc) return AddressClass.Private; // site-local and fc00::/7 unique-local
        return AddressClass.Public;
    }

    /// <summary>
    /// Whether a failed request was refused by this policy. The HTTP stack may wrap what the connect
    /// callback threw, so look one level in.
    /// </summary>
    public static bool IsBlocked(Exception ex) => ex is OutboundBlockedException || ex.InnerException is OutboundBlockedException;

    /// <summary>True for the open internet only — the web archiver's rule.</summary>
    public static bool IsPubliclyRoutable(IPAddress ip) => Classify(ip) == AddressClass.Public;

    private bool Permits(IPAddress ip, bool hostAllowed) => Classify(ip) switch
    {
        AddressClass.Public => true,
        AddressClass.Private => hostAllowed,
        _ => _allowLoopback && IPAddress.IsLoopback(ip),
    };

    // ── The admin's list ────────────────────────────────────────────────────────

    /// <summary>The hosts and addresses the admin has said may be reached, lowercased, in the order written.</summary>
    public IReadOnlyList<string> AllowedHosts() => ParseList(_config.Get(AllowedHostsKey));

    public bool IsHostAllowed(string host)
    {
        var wanted = Normalize(host);
        return wanted is not null && AllowedHosts().Contains(wanted, StringComparer.Ordinal);
    }

    /// <summary>Entries in a stored list, tolerant of stray spaces, blank lines and repeats.</summary>
    public static List<string> ParseList(string? stored) =>
        (stored ?? string.Empty).Split(['\n', ',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(Normalize).Where(h => h is not null).Select(h => h!).Distinct(StringComparer.Ordinal).ToList();

    /// <summary>
    /// A host name or address as it is kept in the list: lowercase, no scheme, port or path. Null when it
    /// isn't one. (An address and a name for the same machine are two entries; allow what you connect to.)
    /// </summary>
    public static string? Normalize(string? input)
    {
        var text = input?.Trim().Trim('[', ']').ToLowerInvariant();
        if (string.IsNullOrEmpty(text) || text.Length > 253) return null;
        if (IPAddress.TryParse(text, out var ip)) return ip.ToString().ToLowerInvariant();
        return Uri.CheckHostName(text) == UriHostNameType.Dns && !text.Contains('/') && !text.Contains(':') ? text : null;
    }

    // ── Checking an address someone typed in ────────────────────────────────────

    /// <summary>
    /// Whether the admin may use this server address, with the reason if not (see <see cref="Problems"/>).
    /// <c>https</c> is required unless the host is on the admin's list (a home server is often plain http).
    /// </summary>
    public async Task<string?> CheckUrlAsync(string? url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url?.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || string.IsNullOrEmpty(uri.Host))
            return Problems.NotAUrl;

        var allowed = IsHostAllowed(uri.Host);
        if (uri.Scheme == "http" && !allowed) return Problems.NeedsHttps;

        IPAddress[] addresses;
        try
        {
            addresses = IPAddress.TryParse(uri.Host.Trim('[', ']'), out var literal)
                ? [literal]
                : await Dns.GetHostAddressesAsync(uri.Host, ct);
        }
        catch (SocketException) { return Problems.Unresolvable; }
        if (addresses.Length == 0) return Problems.Unresolvable;

        if (addresses.Any(a => Classify(a) == AddressClass.Never && !(_allowLoopback && IPAddress.IsLoopback(a))))
            return Problems.Blocked;
        return addresses.All(a => Permits(a, allowed)) ? null : Problems.HostNotAllowed;
    }

    // ── Connecting ──────────────────────────────────────────────────────────────

    private async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var endpoint = context.DnsEndPoint;
        var hostAllowed = IsHostAllowed(endpoint.Host);
        var addresses = IPAddress.TryParse(endpoint.Host, out var literal)
            ? [literal]
            : await Dns.GetHostAddressesAsync(endpoint.Host, ct);

        // All or nothing: one address that isn't allowed is enough to refuse the name.
        if (addresses.Length == 0 || !addresses.All(a => Permits(a, hostAllowed)))
            throw new OutboundBlockedException();

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(addresses, endpoint.Port, ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}
