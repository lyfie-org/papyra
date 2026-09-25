using System.Net;
using System.Net.Mail;

namespace Papyra.Api.Storage;

/// <summary>Outcome of an attempted send, so callers can report a real reason.</summary>
public sealed record EmailResult(bool Sent, string? Error = null)
{
    public static readonly EmailResult NotConfigured = new(false, "Email is not configured.");
    public static EmailResult Ok() => new(true);
    public static EmailResult Fail(string error) => new(false, error);
}

/// <summary>
/// Outbound mail over SMTP, configured from the admin UI (see
/// <see cref="InstanceConfigStore"/> and <see cref="SmtpKeys"/>).
///
/// Deliberately built on <see cref="SmtpClient"/> from the BCL rather than a
/// mail library: Papyra sends a handful of short transactional messages, and the
/// project's rule is that a new dependency has to earn its place. If Papyra ever
/// needs modern OAuth2 SMTP or DKIM signing, that is the moment to reach for
/// MailKit — not before.
///
/// Every send is best-effort and never throws at the caller: mail failing must
/// not fail the action that triggered it. Nobody should lose a mention because
/// the SMTP host was briefly unreachable.
/// </summary>
public sealed class EmailSender
{
    private readonly InstanceConfigStore _config;
    private readonly ILogger<EmailSender> _logger;

    public EmailSender(InstanceConfigStore config, ILogger<EmailSender> logger)
    {
        _config = config;
        _logger = logger;
    }

    /// <summary>True when an admin has switched mail on and given it a host and sender.</summary>
    public bool IsConfigured =>
        _config.GetBool(SmtpKeys.Enabled)
        && _config.Has(SmtpKeys.Host)
        && _config.Has(SmtpKeys.FromAddress);

    /// <summary>
    /// The instance's public base URL, used to build links inside emails. Falls
    /// back to the request's own origin when the admin hasn't set one, because a
    /// reset link pointing at `localhost` is worse than useless in an inbox.
    /// </summary>
    public string PublicUrl(string requestOrigin) =>
        _config.Has(SmtpKeys.PublicUrl)
            ? _config.GetOrEmpty(SmtpKeys.PublicUrl).TrimEnd('/')
            : requestOrigin.TrimEnd('/');

    public async Task<EmailResult> SendAsync(
        string toAddress, string subject, string body, CancellationToken ct = default)
    {
        await _config.EnsureLoadedAsync(ct);
        if (!IsConfigured) return EmailResult.NotConfigured;
        if (string.IsNullOrWhiteSpace(toAddress)) return EmailResult.Fail("No recipient address.");

        var host = _config.GetOrEmpty(SmtpKeys.Host);
        var port = _config.GetInt(SmtpKeys.Port, 587);
        var useSsl = _config.GetBool(SmtpKeys.UseSsl);
        var username = _config.GetOrEmpty(SmtpKeys.Username);

        // Refuse up front what SmtpClient cannot do, rather than hang to a timeout.
        if (SmtpDiagnostics.Precheck(host, port, username) is { } problem)
            return EmailResult.Fail(problem);

        try
        {
            using var message = new MailMessage
            {
                From = new MailAddress(
                    _config.GetOrEmpty(SmtpKeys.FromAddress),
                    _config.GetOrEmpty(SmtpKeys.FromName) is { Length: > 0 } n ? n : "Papyra"),
                Subject = subject,
                Body = body,
                // Plain text on purpose: these are short transactional notes, and
                // a text body renders everywhere without a second HTML version to
                // keep in sync.
                IsBodyHtml = false,
            };
            message.To.Add(toAddress);

            using var client = new SmtpClient(host)
            {
                Port = port,
                EnableSsl = useSsl,
                DeliveryMethod = SmtpDeliveryMethod.Network,
                Timeout = 15_000,
            };

            // An empty username means an unauthenticated relay (common on a LAN
            // mail host); sending default network credentials there would be
            // wrong, so only attach credentials when they were actually given.
            if (_config.Has(SmtpKeys.Username))
            {
                client.UseDefaultCredentials = false;
                client.Credentials = new NetworkCredential(
                    username.Trim(),
                    SmtpDiagnostics.NormalizePassword(host, _config.GetOrEmpty(SmtpKeys.Password)));
            }

            await client.SendMailAsync(message, ct);
            return EmailResult.Ok();
        }
        catch (Exception ex)
        {
            // Logged, not thrown: see the class remarks.
            _logger.LogWarning(ex, "Email send failed to {Recipient}", toAddress);
            return EmailResult.Fail(SmtpDiagnostics.Explain(host, port, useSsl, username, ex));
        }
    }
}

/// <summary>
/// Turns the SMTP server's terse refusals into what to change in the settings.
///
/// A raw <c>5.7.0 Authentication Required</c> says nothing about *why*, and the
/// commonest setups fail in a handful of known ways — above all Gmail, which
/// wants the full address as the username and an App Password, not the account
/// password. The server's own text is kept at the end for anyone who needs it.
/// </summary>
public static class SmtpDiagnostics
{
    private static readonly string[] GoogleHosts = ["smtp.gmail.com", "smtp.googlemail.com"];

    public static bool IsGoogle(string host) =>
        GoogleHosts.Contains(host.Trim().TrimEnd('.').ToLowerInvariant());

    /// <summary>
    /// Google shows an App Password as four groups (<c>abcd efgh ijkl mnop</c>) and
    /// people paste it that way; the spaces are display only and make the login
    /// fail. App Passwords never contain whitespace, so for Google it is removed.
    /// Other servers' passwords are left exactly as typed.
    /// </summary>
    public static string NormalizePassword(string host, string password) =>
        IsGoogle(host) ? string.Concat(password.Where(c => !char.IsWhiteSpace(c))) : password;

    /// <summary>A setting that cannot work, caught before connecting; null when fine.</summary>
    public static string? Precheck(string host, int port, string username)
    {
        if (port == 465)
            return "Port 465 (implicit TLS) isn’t supported. Use port 587 with “Use TLS/SSL” on — " +
                   "every major provider, Gmail included, accepts it.";
        if (IsGoogle(host) && !string.IsNullOrWhiteSpace(username) && !username.Contains('@'))
            return $"Gmail needs the full Gmail address as the username (for example you@gmail.com), " +
                   $"not “{username.Trim()}”. Use the same account that created the App Password.";
        if (IsGoogle(host) && string.IsNullOrWhiteSpace(username))
            return "Gmail requires a login: set the username to your full Gmail address and the " +
                   "password to an App Password.";
        return null;
    }

    public static string Explain(string host, int port, bool useSsl, string username, Exception ex)
    {
        var raw = Flatten(ex);
        var lower = raw.ToLowerInvariant();
        var google = IsGoogle(host);

        string? hint = null;
        if (lower.Contains("starttls") || (lower.Contains("secure connection") && !useSsl))
            hint = "The server requires encryption: turn on “Use TLS/SSL” (port 587).";
        else if (lower.Contains("5.7.8") || lower.Contains("5.7.0") || lower.Contains("535")
                 || lower.Contains("authentication") || lower.Contains("not accepted"))
            hint = google
                ? "Gmail rejected the login. The username must be the full Gmail address, and the " +
                  "password an App Password created for that same account (Google Account → Security → " +
                  "2-Step Verification → App passwords) — your normal Google password will not work."
                : "The server rejected the username or password.";
        else if (lower.Contains("timed out") || lower.Contains("timeout"))
            hint = port == 465
                ? "Port 465 isn’t supported — use 587 with TLS on."
                : $"Couldn’t reach {host}:{port} — check the host, the port, and that outbound SMTP isn’t blocked.";
        else if (lower.Contains("no such host") || lower.Contains("name or service not known"))
            hint = $"The mail host “{host}” couldn’t be found — check the spelling.";
        else if (lower.Contains("5.7.1") || (lower.Contains("sender") && lower.Contains("not")))
            hint = "The server refused the From address. With Gmail it must be the signed-in account " +
                   "or an alias verified in Gmail’s “Send mail as” settings.";

        return hint is null ? raw : $"{hint} (Server said: {raw})";
    }

    // SmtpException wraps the useful part (socket, TLS) in inner exceptions.
    private static string Flatten(Exception ex)
    {
        var parts = new List<string>();
        for (var e = ex; e is not null; e = e.InnerException)
            if (!string.IsNullOrWhiteSpace(e.Message) && !parts.Contains(e.Message.Trim()))
                parts.Add(e.Message.Trim());
        return string.Join(" — ", parts);
    }
}
