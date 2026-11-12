using System.Security.Claims;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Api.Features;

public sealed record TelegramAdminWrite(bool? Enabled, string? Token);

/// <summary>
/// Telegram, from both ends (see <see cref="TelegramChannel"/> and <see cref="TelegramLinker"/>). The admin
/// pastes the bot's token once — Papyra asks Telegram which bot it is, so a wrong token is caught on the spot
/// and the bot's name can be put in the link — and a person connects with one tap on a link. The token is
/// sealed when stored and never returned.
/// </summary>
public static class TelegramEndpoints
{
    public static void MapTelegram(this WebApplication app)
    {
        var admin = app.MapGroup("/api/admin/notifications/telegram")
            .RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");
        admin.MapPut("/", AdminPut).WithSummary("Turn Telegram on or off, and save the bot's token");
        admin.MapPost("/check", AdminCheck).WithSummary("Ask Telegram whether the saved token still works");

        var person = app.MapGroup("/api/notifications/destinations/telegram")
            .RequireAuthorization().WithTags("Notifications");
        person.MapPost("/link", NewLink).RequireRateLimiting(ChannelEndpoints.TestRateLimit)
            .WithSummary("Get a link that connects my Telegram");
    }

    private static async Task<IResult> AdminPut(
        TelegramAdminWrite body, InstanceConfigStore config, TelegramApi api, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var values = new Dictionary<string, string?>();
        string? botUsername = config.Get(ChannelKeys.TelegramBotUsername);

        if (body.Token is not null)
        {
            var token = body.Token.Trim();
            if (token.Length == 0)
            {
                values[ChannelKeys.TelegramBotToken] = string.Empty;
                values[ChannelKeys.TelegramBotUsername] = string.Empty;
                values[ChannelKeys.TelegramOffset] = string.Empty;
                botUsername = null;
            }
            else
            {
                var (bot, error) = await api.GetMeAsync(token, ct);
                if (bot is null) return Results.BadRequest(new { error });
                values[ChannelKeys.TelegramBotToken] = token;
                values[ChannelKeys.TelegramBotUsername] = bot.Username;
                // A different bot has its own message numbering.
                if (!string.Equals(bot.Username, botUsername, StringComparison.OrdinalIgnoreCase))
                    values[ChannelKeys.TelegramOffset] = string.Empty;
                botUsername = bot.Username;
            }
        }
        if (body.Enabled is { } enabled) values[ChannelKeys.Enabled(NotificationCatalog.Telegram)] = enabled ? "true" : "false";
        if (values.Count > 0) await config.SetAsync(values, ct);
        return Results.Ok(new { botUsername });
    }

    private static async Task<IResult> AdminCheck(InstanceConfigStore config, TelegramApi api, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var token = config.Get(ChannelKeys.TelegramBotToken);
        if (string.IsNullOrEmpty(token)) return Results.Ok(new { ok = false, error = "No bot token is saved yet." });

        var (bot, error) = await api.GetMeAsync(token, ct);
        return Results.Ok(new { ok = bot is not null, botUsername = bot?.Username, error });
    }

    private static async Task<IResult> NewLink(ClaimsPrincipal user, TelegramLinker linker, CancellationToken ct)
    {
        var link = await linker.NewLinkAsync(int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!), ct);
        if (link is null)
            return Results.Json(new { error = "Telegram isn't turned on for this Papyra. Ask an administrator." }, statusCode: 409);
        return Results.Ok(new { link.Url, link.ExpiresUtc, link.BotUsername });
    }
}
