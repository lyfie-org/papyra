using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Papyra.Api.Storage.Channels;

public sealed record DiscordBotInfo(string Id, string Username);

/// <summary>
/// The few Discord calls Papyra makes as the admin's bot: who the bot is, and a direct message to a person.
/// Sending needs only plain HTTP — open (or reuse) the DM channel with the person, post into it — so no
/// gateway connection and no heavy dependency. The bot's token is in every request; it never reaches a log
/// or an error message, and failures are described in Papyra's own words.
/// </summary>
public sealed class DiscordBot(OutboundPolicy outbound)
{
    public const string DefaultApi = "https://discord.com/api/v10";

    /// <summary>Tests point this at a server on this machine; nothing else can.</summary>
    internal string ApiBase { get; init; } = DefaultApi;

    // The DM channel with a person doesn't change, so it is opened once.
    private readonly ConcurrentDictionary<string, string> _dmChannels = new();

    private sealed record Reply(int Http, int Code, JsonElement? Body, TimeSpan? RetryAfter, string? Failure);

    public const string CannotMessage =
        "Discord won't let the bot message you. Share a server with the bot, and allow direct messages from server members in Discord's privacy settings.";

    private async Task<Reply> CallAsync(string token, HttpMethod method, string path, object? payload, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(method, ApiBase + path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bot", token);
            if (payload is not null) request.Content = JsonContent.Create(payload);
            using var response = await outbound.Client.SendAsync(request, ct);
            var http = (int)response.StatusCode;
            TimeSpan? retry = response.Headers.RetryAfter?.Delta;
            JsonElement? body = null;
            var code = 0;
            try
            {
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                body = doc.RootElement.Clone();
                if (body.Value.ValueKind == JsonValueKind.Object)
                {
                    if (body.Value.TryGetProperty("code", out var c) && c.TryGetInt32(out var n)) code = n;
                    if (retry is null && body.Value.TryGetProperty("retry_after", out var r) && r.TryGetDouble(out var seconds))
                        retry = TimeSpan.FromSeconds(seconds);
                }
            }
            catch (JsonException) { /* a gateway page, not Discord */ }
            return new Reply(http, code, body, retry, null);
        }
        catch (HttpRequestException ex) when (OutboundPolicy.IsBlocked(ex))
        {
            return new Reply(0, 0, null, null, "Papyra is not allowed to reach Discord from this server.");
        }
        catch (HttpRequestException)
        {
            // The text of this exception can carry the request address; say it in our own words.
            return new Reply(0, 0, null, null, "Papyra could not reach Discord.");
        }
    }

    /// <summary>Asks Discord who owns this token. Used to check it when an admin saves it.</summary>
    public async Task<(DiscordBotInfo? Bot, string? Error)> GetMeAsync(string token, CancellationToken ct)
    {
        var reply = await CallAsync(token, HttpMethod.Get, "/users/@me", null, ct);
        if (reply.Failure is not null) return (null, reply.Failure);
        if (reply.Http == 401) return (null, "Discord doesn't accept that token. Copy it again from the Discord developer portal (Bot → Reset Token).");
        if (reply.Http is < 200 or >= 300) return (null, $"Discord refused the request ({reply.Http}).");
        var body = reply.Body;
        var id = body?.TryGetProperty("id", out var i) == true ? i.GetString() : null;
        var name = body?.TryGetProperty("username", out var u) == true ? u.GetString() : null;
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(name)) return (null, "Discord didn't say which bot this is.");
        return (new DiscordBotInfo(id, name), null);
    }

    /// <summary>Sends a direct message. <paramref name="message"/> is a Discord message body (content and/or embeds).</summary>
    public async Task<ChannelSendResult> SendAsync(string token, string userId, object message, CancellationToken ct)
    {
        if (!_dmChannels.TryGetValue(userId, out var channelId))
        {
            var opened = await CallAsync(token, HttpMethod.Post, "/users/@me/channels", new { recipient_id = userId }, ct);
            if (opened.Failure is not null) return ChannelSendResult.Retry(opened.Failure);
            if (opened.Http is < 200 or >= 300) return Map(opened);
            channelId = opened.Body?.TryGetProperty("id", out var idProp) == true ? idProp.GetString() : null;
            if (string.IsNullOrEmpty(channelId)) return ChannelSendResult.Retry("Discord didn't open the conversation.");
            _dmChannels[userId] = channelId;
        }

        var sent = await CallAsync(token, HttpMethod.Post, $"/channels/{channelId}/messages", message, ct);
        if (sent.Failure is not null) return ChannelSendResult.Retry(sent.Failure);
        if (sent.Http is >= 200 and < 300) return ChannelSendResult.Ok;
        if (sent.Http == 404) _dmChannels.TryRemove(userId, out _); // the conversation is gone: open it afresh next time
        return Map(sent);
    }

    private static ChannelSendResult Map(Reply reply) => reply.Http switch
    {
        429 => ChannelSendResult.Retry("Discord is limiting how fast Papyra can send.", reply.RetryAfter),
        // The bot's own token was refused: the admin's to fix, so keep trying rather than give up on a person.
        401 => ChannelSendResult.Retry("The Discord bot's token was refused. An administrator should check it in Settings → Chat notifications."),
        // 50007: cannot send messages to this user (no shared server, or direct messages closed).
        403 => ChannelSendResult.Rejected(CannotMessage),
        404 => ChannelSendResult.Rejected("Discord can't find that user. Connect Discord again."),
        400 when reply.Code is 50035 or 10013 => ChannelSendResult.Rejected("Discord can't find that user. Connect Discord again."),
        >= 500 => ChannelSendResult.Retry($"Discord had a problem ({reply.Http})."),
        408 => ChannelSendResult.Retry("Discord took too long to answer."),
        _ => ChannelSendResult.Rejected(reply.Code == 0
            ? $"Discord refused the message ({reply.Http})."
            : $"Discord refused the message ({reply.Http}, error {reply.Code})."),
    };
}
