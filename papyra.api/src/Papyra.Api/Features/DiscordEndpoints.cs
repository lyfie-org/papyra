using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Api.Features;

public sealed record DiscordAdminWrite(bool? Enabled, bool? WebhooksAllowed);
public sealed record DiscordWebhookWrite(string? Url);

/// <summary>
/// Discord, from both ends (see <see cref="DiscordChannel"/>). The admin switches it on and decides
/// whether people may connect a channel webhook; a person then gives the webhook's address. The address
/// is the credential, so it is sealed on arrival and is never returned by any endpoint.
/// </summary>
public static class DiscordEndpoints
{
    public static void MapDiscord(this WebApplication app)
    {
        var admin = app.MapGroup("/api/admin/notifications/discord")
            .RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");
        admin.MapPut("/", AdminPut).WithSummary("Turn Discord on or off, and allow or forbid channel webhooks");
        admin.MapPost("/test", AdminTest).WithSummary("Send a test message to a webhook");

        var person = app.MapGroup("/api/notifications/destinations/discord")
            .RequireAuthorization().WithTags("Notifications");
        person.MapPost("/webhook", SetupWebhook).WithSummary("Connect my Discord channel webhook");
    }

    private static int Me(ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    private const string NotAWebhook =
        "That isn't a Discord webhook address. In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.";

    private static async Task<IResult> AdminPut(DiscordAdminWrite body, InstanceConfigStore config, CancellationToken ct)
    {
        var values = new Dictionary<string, string?>();
        if (body.Enabled is { } enabled) values[ChannelKeys.Enabled(NotificationCatalog.Discord)] = enabled ? "true" : "false";
        if (body.WebhooksAllowed is { } allowed) values[ChannelKeys.DiscordWebhooksAllowed] = allowed ? "true" : "false";
        if (values.Count > 0) await config.SetAsync(values, ct);
        return Results.NoContent();
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
}
