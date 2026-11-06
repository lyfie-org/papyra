using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

/// <summary>
/// Sends notifications to ntfy (https://ntfy.sh, or a server the admin runs). The admin turns it on and
/// says which server (blank = the public ntfy.sh) and, if the server wants one, an access token. A person's
/// destination is their topic — which is also the password for reading it, so it is kept sealed and the
/// settings screen suggests a long random one.
///
/// Nothing is sent but the short line from <see cref="ChannelMessage"/> and, when the admin has set the
/// public address, a link to open Papyra from the phone notification.
/// </summary>
public sealed class NtfyChannel(InstanceConfigStore config, OutboundPolicy outbound, SecretBox secrets) : INotificationChannel
{
    public const string DefaultServer = "https://ntfy.sh";

    public string Id => NotificationCatalog.Ntfy;

    // A topic can't be somebody else's address in a way that matters: the worst a wrong one does is
    // send a notification to a topic its owner chose to share. The person says it arrived.
    public bool ConfirmedByPerson => true;

    public bool IsAvailable(InstanceConfigStore store) => store.GetBool(ChannelKeys.Enabled(Id));

    /// <summary>The server notifications go to, without a trailing slash.</summary>
    public static string ServerUrl(InstanceConfigStore store) =>
        store.Has(ChannelKeys.NtfyServer) ? store.GetOrEmpty(ChannelKeys.NtfyServer).Trim().TrimEnd('/') : DefaultServer;

    public async Task<ChannelSendResult> SendAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct)
    {
        var topic = secrets.Open(destination.SecretSealed, "A saved ntfy topic");
        if (string.IsNullOrWhiteSpace(topic))
            return ChannelSendResult.Rejected("The ntfy topic is missing. Set ntfy up again.");

        await config.EnsureLoadedAsync(ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{ServerUrl(config)}/{Uri.EscapeDataString(topic)}")
        {
            Content = new StringContent(message.Title, Encoding.UTF8, "text/plain"),
        };
        request.Headers.TryAddWithoutValidation("Title", "Papyra");
        if (!string.IsNullOrEmpty(message.Link)) request.Headers.TryAddWithoutValidation("Click", message.Link);
        if (config.Get(ChannelKeys.NtfyToken) is { Length: > 0 } token)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        try
        {
            using var response = await outbound.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            return Map(response);
        }
        catch (HttpRequestException ex) when (OutboundPolicy.IsBlocked(ex))
        {
            return ChannelSendResult.Retry(
                "Papyra is not allowed to reach the ntfy server. An administrator can allow it in Admin → Notifications.");
        }
        catch (HttpRequestException)
        {
            // The exception text can carry the address, which holds the topic: say it in our own words.
            return ChannelSendResult.Retry("Papyra could not reach the ntfy server.");
        }
    }

    private static ChannelSendResult Map(HttpResponseMessage response)
    {
        var code = (int)response.StatusCode;
        if (response.IsSuccessStatusCode) return ChannelSendResult.Ok;

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            var after = response.Headers.RetryAfter?.Delta
                ?? (response.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
            return ChannelSendResult.Retry("ntfy is limiting how fast Papyra can send.", after);
        }
        return response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden =>
                ChannelSendResult.Rejected("ntfy refused Papyra. The topic is protected, or the server's access token is wrong."),
            HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed =>
                ChannelSendResult.Rejected("That address isn't an ntfy server. Check the server address with an administrator."),
            HttpStatusCode.RequestTimeout or (HttpStatusCode)425 =>
                ChannelSendResult.Retry($"ntfy answered {code}."),
            _ when code >= 500 => ChannelSendResult.Retry($"ntfy had a problem ({code})."),
            _ => ChannelSendResult.Rejected($"ntfy refused the message ({code})."),
        };
    }
}
