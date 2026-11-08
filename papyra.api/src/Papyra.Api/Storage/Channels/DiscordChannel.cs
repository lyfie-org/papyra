using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

/// <summary>
/// Sends notifications to Discord. For now through a <b>channel webhook</b>: a person makes one in
/// Discord (Server Settings → Integrations → Webhooks) and gives Papyra its address, which is the whole
/// credential, so it is kept sealed and never shown again. Direct messages through a bot come later and
/// will share this channel id.
///
/// A webhook posts into a channel, so everyone who can read that channel can read the messages; the set-up
/// screen says to use a private one, and the admin can forbid webhooks altogether
/// (<see cref="ChannelKeys.DiscordWebhooksAllowed"/>). What is sent is the same short line as everywhere
/// else, as a small card, and never able to ping anyone (<c>allowed_mentions</c> is empty).
/// </summary>
public sealed partial class DiscordChannel(InstanceConfigStore config, OutboundPolicy outbound, SecretBox secrets, DiscordBot? bot = null) : INotificationChannel
{
    public const string WebhookKind = "webhook";
    public const string DirectKind = "dm";

    // Papyra's sage green, as a Discord colour.
    private const int Sage = 0x7AAA8A;

    // The places Discord serves webhooks from. A webhook address on any other host isn't one.
    private static readonly string[] WebhookHosts = ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];

    [GeneratedRegex(@"^/api(/v\d{1,2})?/webhooks/(?<id>\d{15,25})/(?<token>[A-Za-z0-9._-]{20,100})$")]
    private static partial Regex WebhookPath();

    /// <summary>Tests point this channel at a server on this machine; nothing else can.</summary>
    internal bool TrustStoredAddress { get; init; }

    public string Id => NotificationCatalog.Discord;

    public bool IsAvailable(InstanceConfigStore store) => store.GetBool(ChannelKeys.Enabled(Id));

    /// <summary>Whether people may connect a channel webhook. On unless the admin switched it off.</summary>
    public static bool WebhooksAllowed(InstanceConfigStore store) =>
        !string.Equals(store.Get(ChannelKeys.DiscordWebhooksAllowed), "false", StringComparison.OrdinalIgnoreCase);

    // A webhook is the person's own channel, so there is nobody else's address to prove. A direct message
    // goes to a user id anyone could type, so it is proved with a code the bot sends there instead.
    public bool CanBeConfirmedByPerson(ChannelDestination destination) => destination.Kind == WebhookKind;

    /// <summary>Direct messages need the admin's bot: on once a bot token is saved.</summary>
    public static bool DirectMessagesAvailable(InstanceConfigStore store) => store.Has(ChannelKeys.DiscordBotToken);

    /// <summary>
    /// Accept only a real Discord webhook address — https, a Discord host, the standard path, no extras —
    /// and give it back in one canonical form with the webhook's numeric id (which is not secret).
    /// </summary>
    public static bool TryParseWebhook(string? input, out string address, out string webhookId)
    {
        address = webhookId = string.Empty;
        if (!Uri.TryCreate(input?.Trim().TrimEnd('/'), UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length > 0
            || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            return false;
        if (!WebhookHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase)) return false;
        var match = WebhookPath().Match(uri.AbsolutePath);
        if (!match.Success) return false;

        address = $"https://{uri.Host.ToLowerInvariant()}{uri.AbsolutePath}";
        webhookId = match.Groups["id"].Value;
        return true;
    }

    public async Task<ChannelSendResult> SendAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (destination.Kind == DirectKind) return await SendDirectAsync(destination, message, ct);
        if (destination.Kind != WebhookKind)
            return ChannelSendResult.Rejected("This kind of Discord connection isn't available.");

        if (!WebhooksAllowed(config))
            return ChannelSendResult.Rejected("An administrator turned Discord webhooks off.");

        var stored = secrets.Open(destination.SecretSealed, "A saved Discord webhook");
        if (string.IsNullOrWhiteSpace(stored))
            return ChannelSendResult.Rejected("The Discord webhook is missing. Connect it again.");

        var address = stored;
        if (!TrustStoredAddress && !TryParseWebhook(stored, out address, out _))
            return ChannelSendResult.Rejected("That isn't a Discord webhook address. Connect it again.");

        var embed = BuildEmbed(message);
        var payload = new Dictionary<string, object?>
        {
            ["username"] = "Papyra",
            // A line that contains @everyone (a note's title, say) must never ping anyone.
            ["allowed_mentions"] = new { parse = Array.Empty<string>() },
            ["embeds"] = new[] { embed },
        };

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, address) { Content = JsonContent.Create(payload) };
            using var response = await outbound.Client.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct);
            if (response.IsSuccessStatusCode)
            {
                await PaceAsync(response, ct);
                return ChannelSendResult.Ok;
            }
            return await MapAsync(response, ct);
        }
        catch (HttpRequestException ex) when (OutboundPolicy.IsBlocked(ex))
        {
            return ChannelSendResult.Retry(
                "Papyra is not allowed to reach Discord from this server. An administrator can check the network settings.");
        }
        catch (HttpRequestException)
        {
            // The exception text carries the address, which is the credential: say it in our own words.
            return ChannelSendResult.Retry("Papyra could not reach Discord.");
        }
    }

    // A direct message through the admin's bot: the same small card, with no username of its own to show.
    private async Task<ChannelSendResult> SendDirectAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct)
    {
        var token = config.Get(ChannelKeys.DiscordBotToken);
        if (bot is null || string.IsNullOrEmpty(token))
            return ChannelSendResult.Retry("Discord direct messages aren't set up on this server. An administrator can add the bot in Settings → Chat notifications.");
        if (!UserIdPattern().IsMatch(destination.Handle))
            return ChannelSendResult.Rejected("The Discord user is missing. Connect Discord again.");

        return await bot.SendAsync(token, destination.Handle, new
        {
            allowed_mentions = new { parse = Array.Empty<string>() },
            embeds = new[] { BuildEmbed(message) },
        }, ct);
    }

    /// <summary>A Discord user id: a snowflake, 15–25 digits.</summary>
    [GeneratedRegex(@"^\d{15,25}$")]
    public static partial Regex UserIdPattern();

    private static Dictionary<string, object?> BuildEmbed(ChannelMessage message)
    {
        var embed = new Dictionary<string, object?> { ["title"] = Clip(message.Title, 250), ["color"] = Sage };
        if (Uri.TryCreate(message.Link, UriKind.Absolute, out var link) && link.Scheme is "http" or "https")
            embed["url"] = link.AbsoluteUri;
        return embed;
    }

    // Discord tells every answer how many sends are left in the current window. When none are, wait for
    // the window here (the queue sends one message at a time) instead of earning a 429 and a long retry.
    private static async Task PaceAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (!TryHeader(response, "X-RateLimit-Remaining", out var remaining) || remaining > 0) return;
        if (!TryHeader(response, "X-RateLimit-Reset-After", out var resetAfter) || resetAfter <= 0) return;
        await Task.Delay(TimeSpan.FromSeconds(Math.Min(resetAfter, 5)), ct);
    }

    private static async Task<ChannelSendResult> MapAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var code = (int)response.StatusCode;
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
            return ChannelSendResult.Retry("Discord is limiting how fast Papyra can send.", await RetryAfterAsync(response, ct));

        var discordCode = await DiscordErrorCodeAsync(response, ct);
        return response.StatusCode switch
        {
            // 10015: Unknown Webhook — it was deleted. 401: the token part no longer matches.
            HttpStatusCode.NotFound or HttpStatusCode.Unauthorized =>
                ChannelSendResult.Rejected("The Discord webhook was deleted or changed. Make a new one in Discord and connect it again."),
            HttpStatusCode.Forbidden =>
                ChannelSendResult.Rejected("Discord won't let this webhook post. Check the channel's permissions."),
            HttpStatusCode.RequestTimeout => ChannelSendResult.Retry("Discord took too long to answer."),
            _ when code >= 500 => ChannelSendResult.Retry($"Discord had a problem ({code})."),
            _ => ChannelSendResult.Rejected(
                discordCode is null ? $"Discord refused the message ({code})." : $"Discord refused the message ({code}, error {discordCode})."),
        };
    }

    private static async Task<TimeSpan?> RetryAfterAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.Headers.RetryAfter?.Delta is { } delta) return delta;
        if (TryHeader(response, "X-RateLimit-Reset-After", out var resetAfter)) return TimeSpan.FromSeconds(resetAfter);
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.TryGetProperty("retry_after", out var value) && value.TryGetDouble(out var seconds))
                return TimeSpan.FromSeconds(seconds);
        }
        catch (JsonException) { /* not JSON (e.g. a CDN page): fall back to the default backoff */ }
        return null;
    }

    private static async Task<int?> DiscordErrorCodeAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.TryGetProperty("code", out var value) && value.TryGetInt32(out var code)) return code;
        }
        catch (JsonException) { /* not JSON */ }
        return null;
    }

    private static bool TryHeader(HttpResponseMessage response, string name, out double value)
    {
        value = 0;
        return response.Headers.TryGetValues(name, out var values)
            && double.TryParse(values.FirstOrDefault(), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
    }

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
