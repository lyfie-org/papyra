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

            using var client = new SmtpClient(_config.GetOrEmpty(SmtpKeys.Host))
            {
                Port = _config.GetInt(SmtpKeys.Port, 587),
                EnableSsl = _config.GetBool(SmtpKeys.UseSsl),
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
                    _config.GetOrEmpty(SmtpKeys.Username),
                    _config.GetOrEmpty(SmtpKeys.Password));
            }

            await client.SendMailAsync(message, ct);
            return EmailResult.Ok();
        }
        catch (Exception ex)
        {
            // Logged, not thrown: see the class remarks.
            _logger.LogWarning(ex, "Email send failed to {Recipient}", toAddress);
            return EmailResult.Fail(ex.Message);
        }
    }
}
