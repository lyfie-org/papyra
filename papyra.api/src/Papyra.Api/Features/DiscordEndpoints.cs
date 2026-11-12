using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Api.Features;

public sealed record DiscordAdminWrite(bool? Enabled, bool? WebhooksAllowed, string? BotToken = null);
public sealed record DiscordWebhookWrite(string? Url);
public sealed record DiscordDirectWrite(string? UserId);
public sealed record DiscordCodeWrite(string? Code);

/// <summary>
/// Discord, from both ends (see <see cref="DiscordChannel"/>). The admin switches it on, decides whether
/// people may connect a channel webhook, and may add a bot for direct messages. A person connects either a
/// webhook (its address is the credential: sealed on arrival, never returned) or their Discord user id, which
/// the bot proves is theirs by sending a code to that account for them to type back here.
/// </summary>
public static class DiscordEndpoints
{
    public static void MapDiscord(this WebApplication app)
    {
        var admin = app.MapGroup("/api/admin/notifications/discord")
            .RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");
        admin.MapPut("/", AdminPut).WithSummary("Turn Discord on or off, and allow or forbid channel webhooks");
        admin.MapPost("/test", AdminTest).WithSummary("Send a test message to a webhook");
        admin.MapPost("/check-bot", AdminCheckBot).WithSummary("Ask Discord whether the saved bot token still works");

        var person = app.MapGroup("/api/notifications/destinations/discord")
            .RequireAuthorization().WithTags("Notifications");
        person.MapPost("/webhook", SetupWebhook).WithSummary("Connect my Discord channel webhook");
        person.MapPost("/dm", SetupDirect).RequireRateLimiting(ChannelEndpoints.TestRateLimit)
            .WithSummary("Connect Discord direct messages: the bot sends a code to my account");
        person.MapPost("/dm/confirm", ConfirmDirect).RequireRateLimiting(ChannelEndpoints.TestRateLimit)
            .WithSummary("Type back the code the bot sent me");
    }

    private static int Me(ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    private const string NotAWebhook =
        "That isn't a Discord webhook address. In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.";

    private static async Task<IResult> AdminPut(
        DiscordAdminWrite body, InstanceConfigStore config, DiscordBot bot, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var values = new Dictionary<string, string?>();
        if (body.Enabled is { } enabled) values[ChannelKeys.Enabled(NotificationCatalog.Discord)] = enabled ? "true" : "false";
        if (body.WebhooksAllowed is { } allowed) values[ChannelKeys.DiscordWebhooksAllowed] = allowed ? "true" : "false";

        if (body.BotToken is not null)
        {
            var token = body.BotToken.Trim();
            if (token.Length == 0)
            {
                values[ChannelKeys.DiscordBotToken] = string.Empty;
                values[ChannelKeys.DiscordBotUsername] = string.Empty;
            }
            else
            {
                // Discord says whose token it is, so a wrong one is caught now and the bot can be named.
                var (info, error) = await bot.GetMeAsync(token, ct);
                if (info is null) return Results.BadRequest(new { error });
                values[ChannelKeys.DiscordBotToken] = token;
                values[ChannelKeys.DiscordBotUsername] = info.Username;
            }
        }
        if (values.Count > 0) await config.SetAsync(values, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> AdminCheckBot(InstanceConfigStore config, DiscordBot bot, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var token = config.Get(ChannelKeys.DiscordBotToken);
        if (string.IsNullOrEmpty(token)) return Results.Ok(new { ok = false, error = "No bot token is saved yet." });

        var (info, error) = await bot.GetMeAsync(token, ct);
        return Results.Ok(new { ok = info is not null, botUsername = info?.Username, error });
    }

    // Tries a webhook without saving it. Admins only, and the address isn't kept or echoed.
    private static async Task<IResult> AdminTest(
        DiscordWebhookWrite body, InstanceConfigStore config, DiscordChannel discord, SecretBox secrets, CancellationToken ct)
    {
        if (!DiscordChannel.TryParseWebhook(body.Url, out var address, out _))
            return Results.BadRequest(new { error = NotAWebhook });

        await config.EnsureLoadedAsync(ct);
        var probe = new ChannelDestination
        {
            Channel = NotificationCatalog.Discord, Kind = DiscordChannel.WebhookKind, SecretSealed = secrets.Seal(address),
        };
        var result = await discord.SendAsync(probe,
            new ChannelMessage("channels.test", "Papyra test: Discord is connected.", null), ct);
        return Results.Ok(new { ok = result.Outcome == ChannelOutcome.Sent, error = result.Error });
    }

    private static async Task<IResult> SetupWebhook(
        DiscordWebhookWrite body, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config,
        DiscordChannel discord, SecretBox secrets, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (!discord.IsAvailable(config))
            return Results.Json(new { error = "Discord isn't turned on for this Papyra. Ask an administrator." }, statusCode: 409);
        if (!DiscordChannel.WebhooksAllowed(config))
            return Results.Json(new { error = "An administrator has turned Discord webhooks off." }, statusCode: 409);
        if (!DiscordChannel.TryParseWebhook(body.Url, out var address, out var webhookId))
            return Results.BadRequest(new { error = NotAWebhook });

        var uid = Me(user);
        // One Discord connection per person: connecting again replaces it, and its queued messages go.
        var old = await db.ChannelDestinations.Where(d => d.UserId == uid && d.Channel == NotificationCatalog.Discord).ToListAsync(ct);
        foreach (var d in old)
            await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.RemoveRange(old);

        var destination = new ChannelDestination
        {
            UserId = uid, Channel = NotificationCatalog.Discord, Kind = DiscordChannel.WebhookKind,
            Handle = webhookId, // the numeric id is not secret; the token in the address is
            SecretSealed = secrets.Seal(address),
            Label = "Discord · channel",
            Verified = false, Enabled = true, CreatedUtc = DateTime.UtcNow,
        };
        db.ChannelDestinations.Add(destination);
        await db.SaveChangesAsync(ct);

        // Everyone who can read that channel can read what is sent to it: the screen says so.
        return Results.Ok(new { destination.Id, destination.Label, kind = destination.Kind, sharedWithChannel = true });
    }
    // ── Direct messages ─────────────────────────────────────────────────────────

    private const string NotAUserId =
        "That doesn't look like a Discord user ID. In Discord: Settings → Advanced → turn on Developer Mode, then right-click your name → Copy User ID.";

    private const string BadCode = "That code doesn't match, or it has expired. Ask for a new one.";

    // The bot sends a code to the account; typing it back proves the account is yours, since a user id is
    // something anyone could type. The destination exists, unverified, only once the code was really sent.
    private static async Task<IResult> SetupDirect(
        DiscordDirectWrite body, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config,
        DiscordChannel discord, DiscordBot bot, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (!discord.IsAvailable(config))
            return Results.Json(new { error = "Discord isn't turned on for this Papyra. Ask an administrator." }, statusCode: 409);
        var token = config.Get(ChannelKeys.DiscordBotToken);
        if (!DiscordChannel.DirectMessagesAvailable(config) || string.IsNullOrEmpty(token))
            return Results.Json(new { error = "Direct messages aren't set up on this Papyra. Ask an administrator, or use a channel webhook." }, statusCode: 409);

        var userId = body.UserId?.Trim();
        if (userId is null || !DiscordChannel.UserIdPattern().IsMatch(userId))
            return Results.BadRequest(new { error = NotAUserId });

        var code = LinkCodes.New(8);
        var shown = $"{code[..4]}-{code[4..]}".ToUpperInvariant();
        var sent = await bot.SendAsync(token, userId, new
        {
            content = $"Your Papyra code is **{shown}**. Type it in Papyra to finish connecting Discord. If you didn't ask for this, you can ignore it.",
            allowed_mentions = new { parse = Array.Empty<string>() },
        }, ct);
        if (sent.Outcome != ChannelOutcome.Sent)
            return Results.Json(new { error = sent.Error ?? "Discord did not take the message." }, statusCode: 409);

        var uid = int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var now = DateTime.UtcNow;
        // One Discord connection per person: this replaces any earlier one and its queued messages.
        var old = await db.ChannelDestinations.Where(d => d.UserId == uid && d.Channel == NotificationCatalog.Discord).ToListAsync(ct);
        foreach (var d in old)
            await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.RemoveRange(old);
        await db.ChannelLinkCodes
            .Where(c => c.ExpiresUtc < now || (c.UserId == uid && c.Channel == NotificationCatalog.Discord))
            .ExecuteDeleteAsync(ct);

        var destination = new ChannelDestination
        {
            UserId = uid, Channel = NotificationCatalog.Discord, Kind = DiscordChannel.DirectKind,
            Handle = userId, Label = "Discord · direct message", Verified = false, Enabled = true, CreatedUtc = now,
        };
        db.ChannelDestinations.Add(destination);
        db.ChannelLinkCodes.Add(new ChannelLinkCode
        {
            UserId = uid, Channel = NotificationCatalog.Discord, CodeHash = LinkCodes.Hash(code), ExpiresUtc = now.AddMinutes(10),
        });
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { destination.Id, destination.Label, kind = destination.Kind, expiresUtc = now.AddMinutes(10) });
    }

    private static async Task<IResult> ConfirmDirect(
        DiscordCodeWrite body, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config, DiscordBot bot, CancellationToken ct)
    {
        var typed = LinkCodes.Normalize(body.Code);
        if (typed.Length != 8) return Results.BadRequest(new { error = BadCode });

        var uid = int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var hash = LinkCodes.Hash(typed);
        var now = DateTime.UtcNow;
        var row = await db.ChannelLinkCodes.FirstOrDefaultAsync(
            c => c.UserId == uid && c.Channel == NotificationCatalog.Discord && c.CodeHash == hash, ct);
        var destination = await db.ChannelDestinations.FirstOrDefaultAsync(
            d => d.UserId == uid && d.Channel == NotificationCatalog.Discord && d.Kind == DiscordChannel.DirectKind, ct);
        if (row is null || row.ExpiresUtc < now || destination is null)
        {
            if (row is not null && row.ExpiresUtc < now) { db.ChannelLinkCodes.Remove(row); await db.SaveChangesAsync(ct); }
            return Results.BadRequest(new { error = BadCode });
        }

        destination.Verified = true;
        destination.LastOkUtc = now;
        db.ChannelLinkCodes.Remove(row);
        await db.SaveChangesAsync(ct);

        // A last word in the conversation, so the account that got the code can see it worked.
        await config.EnsureLoadedAsync(ct);
        if (config.Get(ChannelKeys.DiscordBotToken) is { Length: > 0 } token)
            _ = await bot.SendAsync(token, destination.Handle, new { content = "Connected. Papyra will send your notifications here." }, ct);
        return Results.NoContent();
    }
}
