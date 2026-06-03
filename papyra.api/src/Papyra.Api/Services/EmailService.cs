using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

// ── EmailService ──────────────────────────────────────────────────────────────
// Sends email via SMTP (MailKit). Config comes from GlobalSettingsModel.Smtp.
// Password is decrypted on each send — never cached in memory beyond the call.
// Throws SmtpConfigurationException when no SMTP config is stored, so callers
// can surface a descriptive error without special-casing null checks.

public sealed class EmailService(GlobalSettingsService globalSettings, EncryptionService encryption)
{
    public async Task SendAsync(string toAddress, string subject, string htmlBody,
        CancellationToken ct = default)
    {
        var cfg = await GetSmtpSettingsAsync()
            ?? throw new SmtpConfigurationException("SMTP is not configured.");

        var password = cfg.PasswordEnc is { Length: > 0 }
            ? encryption.Decrypt(cfg.PasswordEnc)
            : string.Empty;

        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(cfg.FromName, cfg.FromAddress));
        message.To.Add(MailboxAddress.Parse(toAddress));
        message.Subject = subject;
        message.Body    = new TextPart("html") { Text = htmlBody };

        using var client = new SmtpClient();

        var socketOptions = cfg.Security switch
        {
            "ssl"      => SecureSocketOptions.SslOnConnect,
            "starttls" => SecureSocketOptions.StartTls,
            _          => SecureSocketOptions.None,
        };

        await client.ConnectAsync(cfg.Host, cfg.Port, socketOptions, ct);

        if (!string.IsNullOrEmpty(cfg.Username))
            await client.AuthenticateAsync(cfg.Username, password, ct);

        await client.SendAsync(message, ct);
        await client.DisconnectAsync(quit: true, ct);
    }

    // Probes the SMTP connection (connect + auth) without sending a message.
    // Returns null on success; an error description on failure.
    public async Task<string?> TestConnectionAsync(CancellationToken ct = default)
    {
        var cfg = await GetSmtpSettingsAsync();
        if (cfg is null) return "SMTP is not configured.";

        try
        {
            var password = cfg.PasswordEnc is { Length: > 0 }
                ? encryption.Decrypt(cfg.PasswordEnc)
                : string.Empty;

            using var client = new SmtpClient();

            var socketOptions = cfg.Security switch
            {
                "ssl"      => SecureSocketOptions.SslOnConnect,
                "starttls" => SecureSocketOptions.StartTls,
                _          => SecureSocketOptions.None,
            };

            await client.ConnectAsync(cfg.Host, cfg.Port, socketOptions, ct);

            if (!string.IsNullOrEmpty(cfg.Username))
                await client.AuthenticateAsync(cfg.Username, password, ct);

            await client.DisconnectAsync(quit: true, ct);
            return null;
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
    }

    public async Task<SmtpSettings?> GetSmtpSettingsAsync()
    {
        var settings = await globalSettings.GetAsync();
        return settings.Smtp;
    }

    public bool IsConfigured(SmtpSettings? cfg) =>
        cfg is { Host.Length: > 0, FromAddress.Length: > 0 };
}

public sealed class SmtpConfigurationException(string message) : Exception(message);
