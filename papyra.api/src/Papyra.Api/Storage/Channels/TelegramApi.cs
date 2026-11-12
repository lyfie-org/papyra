using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Papyra.Api.Storage.Channels;

/// <summary>A message the bot received (only private chats and plain text matter to Papyra).</summary>
public sealed record TelegramUpdate(long UpdateId, long? ChatId, string? ChatType, string? Text, string? Username, string? FirstName);

public sealed record TelegramBot(string Username, string Name);

public sealed record TelegramUpdates(IReadOnlyList<TelegramUpdate> Updates, string? Error, bool BadToken = false)
{
    public static TelegramUpdates Failed(string error, bool badToken = false) => new([], error, badToken);
}

/// <summary>
/// The few Telegram Bot API calls Papyra makes: who the bot is, send a message, and read what was sent to
/// the bot. The bot's token is part of every address, so it is the one thing that must never reach a log or an
/// error message; failures here are described in Papyra's own words.
/// </summary>
public sealed class TelegramApi(OutboundPolicy outbound)
{
    public const string DefaultBaseUrl = "https://api.telegram.org";

    /// <summary>Tests point this at a server on this machine; nothing else can.</summary>
    internal string BaseUrl { get; init; } = DefaultBaseUrl;

    private readonly Lazy<HttpClient> _longPoll = new(() => outbound.CreateClient(Timeout.InfiniteTimeSpan));

    // What came back, or why nothing did.
    private sealed record Reply(
        bool Ok, int Http, int Code, string? Description, int? RetryAfter, JsonElement? Result, string? Failure);

    private async Task<Reply> PostAsync(HttpClient client, string token, string method, object payload, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{BaseUrl}/bot{token}/{method}")
            {
                Content = JsonContent.Create(payload),
            };
            using var response = await client.SendAsync(request, ct);
            var http = (int)response.StatusCode;
            try
            {
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                var root = doc.RootElement;
                var ok = root.TryGetProperty("ok", out var okProp) && okProp.ValueKind == JsonValueKind.True;
                var code = root.TryGetProperty("error_code", out var c) && c.TryGetInt32(out var n) ? n : http;
                var description = root.TryGetProperty("description", out var d) ? d.GetString() : null;
                int? retryAfter = root.TryGetProperty("parameters", out var p)
                    && p.TryGetProperty("retry_after", out var r) && r.TryGetInt32(out var seconds) ? seconds : null;
                JsonElement? result = root.TryGetProperty("result", out var res) ? res.Clone() : null;
                return new Reply(ok, http, code, description, retryAfter, result, null);
            }
            catch (JsonException)
            {
                // A gateway page, not Telegram.
                return new Reply(false, http, http, null, null, null, $"Telegram answered with something unexpected ({http}).");
            }
        }
        catch (HttpRequestException ex) when (OutboundPolicy.IsBlocked(ex))
        {
            return new Reply(false, 0, 0, null, null, null, "Papyra is not allowed to reach Telegram from this server.");
        }
        catch (HttpRequestException)
        {
            // The exception text would carry the address, which contains the bot's token.
            return new Reply(false, 0, 0, null, null, null, "Papyra could not reach Telegram.");
        }
    }

    /// <summary>Asks Telegram who owns this token. Used to check it when an admin saves it.</summary>
    public async Task<(TelegramBot? Bot, string? Error)> GetMeAsync(string token, CancellationToken ct)
    {
        var reply = await PostAsync(outbound.Client, token, "getMe", new { }, ct);
        if (reply.Failure is not null) return (null, reply.Failure);
        if (!reply.Ok)
            return (null, reply.Code is 401 or 404
                ? "Telegram doesn't accept that token. Copy it again from BotFather."
                : $"Telegram refused the request ({reply.Code}).");
        var name = reply.Result?.TryGetProperty("username", out var u) == true ? u.GetString() : null;
        if (string.IsNullOrEmpty(name)) return (null, "Telegram didn't say which bot this is.");
        var first = reply.Result?.TryGetProperty("first_name", out var f) == true ? f.GetString() : null;
        return (new TelegramBot(name, first ?? name), null);
    }

    public async Task<ChannelSendResult> SendMessageAsync(string token, string chatId, string text, CancellationToken ct)
    {
        object chat = long.TryParse(chatId, out var numeric) ? numeric : chatId;
        var reply = await PostAsync(outbound.Client, token, "sendMessage",
            new { chat_id = chat, text, disable_web_page_preview = true }, ct);

        if (reply.Failure is not null) return ChannelSendResult.Retry(reply.Failure);
        if (reply.Ok) return ChannelSendResult.Ok;

        return reply.Code switch
        {
            429 => ChannelSendResult.Retry("Telegram is limiting how fast Papyra can send.",
                reply.RetryAfter is { } s ? TimeSpan.FromSeconds(s) : null),
            // "Forbidden: bot was blocked by the user" / "user is deactivated": it won't heal on its own.
            403 => ChannelSendResult.Rejected(
                "Telegram says the bot can't message you any more — you may have blocked it. Unblock the bot and connect Telegram again."),
            400 when reply.Description?.Contains("chat not found", StringComparison.OrdinalIgnoreCase) == true =>
                ChannelSendResult.Rejected("Telegram can't find that chat. Connect Telegram again."),
            // The bot's own token was refused: that is the admin's to fix, so keep trying rather than give up on a person.
            401 or 404 => ChannelSendResult.Retry(
                "The Telegram bot's token was refused. An administrator should check it in Admin → Notifications."),
            408 or 409 => ChannelSendResult.Retry($"Telegram answered {reply.Code}."),
            >= 500 => ChannelSendResult.Retry($"Telegram had a problem ({reply.Code})."),
            _ => ChannelSendResult.Rejected($"Telegram refused the message ({reply.Code})."),
        };
    }

    /// <summary>
    /// Waits up to <paramref name="holdSeconds"/> for messages sent to the bot, starting at <paramref name="offset"/>
    /// (everything before it is acknowledged and forgotten by Telegram).
    /// </summary>
    public async Task<TelegramUpdates> GetUpdatesAsync(string token, long offset, int holdSeconds, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(TimeSpan.FromSeconds(holdSeconds + 15));

        Reply reply;
        try
        {
            reply = await PostAsync(_longPoll.Value, token, "getUpdates",
                new { offset, timeout = holdSeconds, allowed_updates = new[] { "message" } }, limit.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return TelegramUpdates.Failed("Telegram did not answer in time.");
        }

        if (reply.Failure is not null) return TelegramUpdates.Failed(reply.Failure);
        if (!reply.Ok)
        {
            return reply.Code switch
            {
                401 or 404 => TelegramUpdates.Failed("Telegram doesn't accept the bot's token.", badToken: true),
                // Telegram allows one reader per bot: a webhook, or another Papyra using the same bot.
                409 => TelegramUpdates.Failed("Something else is already reading this bot's messages (a webhook, or another program using the same bot)."),
                _ => TelegramUpdates.Failed($"Telegram refused the request ({reply.Code})."),
            };
        }

        var updates = new List<TelegramUpdate>();
        if (reply.Result is { ValueKind: JsonValueKind.Array } items)
        {
            foreach (var item in items.EnumerateArray())
            {
                if (!item.TryGetProperty("update_id", out var idProp) || !idProp.TryGetInt64(out var updateId)) continue;
                long? chatId = null;
                string? chatType = null, text = null, username = null, firstName = null;
                if (item.TryGetProperty("message", out var message))
                {
                    if (message.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String) text = t.GetString();
                    if (message.TryGetProperty("chat", out var chat))
                    {
                        if (chat.TryGetProperty("id", out var cid) && cid.TryGetInt64(out var idValue)) chatId = idValue;
                        if (chat.TryGetProperty("type", out var ct2)) chatType = ct2.GetString();
                        if (chat.TryGetProperty("username", out var un)) username = un.GetString();
                        if (chat.TryGetProperty("first_name", out var fn)) firstName = fn.GetString();
                    }
                }
                updates.Add(new TelegramUpdate(updateId, chatId, chatType, text, username, firstName));
            }
        }
        return new TelegramUpdates(updates, null);
    }
}
