using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Api.Features;

public sealed record ChannelDestinationUpdate(bool? Enabled, string? PrivacyTier);

/// <summary>
/// A person's own chat destinations (see <see cref="ChannelDestination"/>): what is connected and in
/// what state, the switch, the privacy tier and removal. Connecting one is done by each channel's own
/// set-up (it has to prove the address is the person's); nothing here ever returns a secret or the
/// raw handle.
/// </summary>
public static class ChannelEndpoints
{
    public static void MapChannelDestinations(this WebApplication app)
    {
        var group = app.MapGroup("/api/notifications/destinations").RequireAuthorization().WithTags("Notifications");
        group.MapGet("/", List).WithSummary("Where my notifications are sent besides email");
        group.MapPatch("/{id:int}", Update).WithSummary("Switch a destination on or off, or change what it shows");
        group.MapDelete("/{id:int}", Remove).WithSummary("Disconnect a destination");
        group.MapPost("/{id:int}/test", Test).RequireRateLimiting(TestRateLimit)
            .WithSummary("Send a test message to a destination");
        group.MapPost("/{id:int}/confirm", Confirm)
            .WithSummary("Say the test message arrived, for channels where that is how it's verified");
    }

    /// <summary>Test messages go to a third party, so they are paced per account.</summary>
    public const string TestRateLimit = "channel-test";

    private static int Me(ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    /// <summary>
    /// What the card shows. "unverified" has not been proved yet, "paused" was stopped by Papyra,
    /// "off" is the person's own switch, "attention" last failed after it last worked, else "connected".
    /// </summary>
    public static string State(ChannelDestination d) =>
        !d.Verified ? "unverified"
        : d.PausedUtc is not null ? "paused"
        : !d.Enabled ? "off"
        : d.LastErrorUtc is { } failed && (d.LastOkUtc is null || failed > d.LastOkUtc) ? "attention"
        : "connected";

    private static async Task<IResult> List(
        ClaimsPrincipal user, AppDbContext db, ChannelDeliveryService delivery, InstanceConfigStore config, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var uid = Me(user);
        var rows = await db.ChannelDestinations.AsNoTracking().Where(d => d.UserId == uid)
            .OrderBy(d => d.Channel).ToListAsync(ct);
        var available = delivery.AvailableChannels();
        return Results.Ok(new
        {
            available,
            destinations = rows.Select(d => new
            {
                d.Id, d.Channel, d.Kind, d.Label, d.Verified, d.Enabled, d.PrivacyTier,
                state = State(d), d.LastOkUtc, d.LastErrorUtc, d.LastError, d.PausedUtc,
            }),
        });
    }

    private static async Task<IResult> Update(
        int id, ChannelDestinationUpdate body, ClaimsPrincipal user, AppDbContext db, CancellationToken ct)
    {
        var uid = Me(user);
        var d = await db.ChannelDestinations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        if (d is null) return Results.NotFound();

        if (body.PrivacyTier is not null)
        {
            var tier = body.PrivacyTier.Trim().ToLowerInvariant();
            if (tier != ChannelPrivacy.Minimal && tier != ChannelPrivacy.Titles)
                return Results.BadRequest(new { error = "Choose \"minimal\" or \"titles\"." });
            d.PrivacyTier = tier;
        }
        if (body.Enabled is { } enabled)
        {
            d.Enabled = enabled;
            // Turning a destination back on is also how a paused one is tried again.
            if (enabled)
            {
                d.PausedUtc = null;
                d.ConsecutiveFailures = 0;
            }
        }
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // A message that skips the queue and the person's switches: "does this work?". It does not count
    // toward pausing the destination, but what it learns is shown on the card.
    private static async Task<IResult> Test(
        int id, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config,
        IEnumerable<INotificationChannel> providers, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var uid = Me(user);
        var d = await db.ChannelDestinations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        if (d is null) return Results.NotFound();

        var provider = providers.FirstOrDefault(p => p.Id == d.Channel);
        if (provider is null || !provider.IsAvailable(config))
            return Results.Json(new { error = "This kind of notification isn't turned on for this Papyra." }, statusCode: 409);

        ChannelSendResult result;
        try
        {
            result = await provider.SendAsync(d,
                new ChannelMessage("channels.test", $"Papyra test: {ChannelDeliveryService.ChannelName(d.Channel)} is connected.", null), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            result = ChannelSendResult.Retry("Something went wrong while sending.");
        }

        var now = DateTime.UtcNow;
        if (result.Outcome == ChannelOutcome.Sent)
        {
            d.LastOkUtc = now;
            d.LastError = null;
        }
        else
        {
            d.LastErrorUtc = now;
            d.LastError = result.Error;
        }
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { ok = result.Outcome == ChannelOutcome.Sent, error = result.Error });
    }

    private static async Task<IResult> Confirm(
        int id, ClaimsPrincipal user, AppDbContext db, IEnumerable<INotificationChannel> providers, CancellationToken ct)
    {
        var uid = Me(user);
        var d = await db.ChannelDestinations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        if (d is null) return Results.NotFound();

        var provider = providers.FirstOrDefault(p => p.Id == d.Channel);
        if (provider is null || !provider.ConfirmedByPerson)
            return Results.BadRequest(new { error = "This one is confirmed with a code, not by saying so." });
        // The person vouches for a message that was really sent: no confirming before a test went through.
        if (d.LastOkUtc is null)
            return Results.Json(new { error = "Send the test message first." }, statusCode: 409);

        d.Verified = true;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> Remove(int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct)
    {
        var uid = Me(user);
        var d = await db.ChannelDestinations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid, ct);
        if (d is null) return Results.NotFound();

        // Anything still waiting for it goes with it.
        await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.Remove(d);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
