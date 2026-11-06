using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Papyra.Api.Storage.Channels;

namespace Papyra.Api.Features;

public sealed record NtfyAdminWrite(bool? Enabled, string? ServerUrl, string? Token, bool? AllowHost);
public sealed record AllowedHostsWrite(string[]? Hosts);
public sealed record NtfyTestWrite(string? Topic);
public sealed record NtfySetupWrite(string? Topic);

/// <summary>
/// ntfy, from both ends. The admin turns it on once (server, optional access token) and lists any
/// hosts on their own network Papyra may reach; each person then connects a topic. Secrets — the
/// access token and a person's topic — are sealed when stored and never come back out of the admin
/// payload; a person can read back their own topic, because they need it to subscribe on a new device.
/// </summary>
public static partial class NtfyEndpoints
{
    /// <summary>ntfy's own rule for a topic name.</summary>
    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex TopicPattern();

    /// <summary>A topic shorter than this is easy to guess, and the topic is the only thing keeping it private.</summary>
    public const int StrongTopicLength = 12;

    public static void MapNtfy(this WebApplication app)
    {
        var admin = app.MapGroup("/api/admin/notifications")
            .RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");
        admin.MapGet("/", AdminGet).WithSummary("How chat notifications are set up on this Papyra");
        admin.MapPut("/ntfy", AdminPutNtfy).WithSummary("Turn ntfy on or off, set its server and access token");
        admin.MapPost("/ntfy/test", AdminTest).WithSummary("Send a test message to a topic");
        admin.MapPut("/allowed-hosts", AdminPutHosts).WithSummary("Hosts on your own network Papyra may connect to");

        var person = app.MapGroup("/api/notifications/destinations/ntfy")
            .RequireAuthorization().WithTags("Notifications");
        person.MapPost("/", Setup).WithSummary("Connect my ntfy topic");
        person.MapGet("/{id:int}/address", Address).WithSummary("My ntfy topic and subscribe address");
    }

    private static int Me(ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    // ── Admin ───────────────────────────────────────────────────────────────────

    private static async Task<IResult> AdminGet(InstanceConfigStore config, OutboundPolicy outbound, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        return Results.Ok(new
        {
            ntfy = new
            {
                enabled = config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Ntfy)),
                serverUrl = config.GetOrEmpty(ChannelKeys.NtfyServer),
                defaultServerUrl = NtfyChannel.DefaultServer,
                hasToken = config.Has(ChannelKeys.NtfyToken),
            },
            discord = new
            {
                enabled = config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Discord)),
                webhooksAllowed = DiscordChannel.WebhooksAllowed(config),
            },
            allowedHosts = outbound.AllowedHosts(),
        });
    }

    private static string Explain(string problem) => problem switch
    {
        OutboundPolicy.Problems.NotAUrl => "Enter the server's full address, for example https://ntfy.sh.",
        OutboundPolicy.Problems.NeedsHttps => "Use an https address. A plain http address works only for a host on your allowed list.",
        OutboundPolicy.Problems.Blocked => "Papyra can never connect to that address (this machine itself, a link-local or reserved address).",
        OutboundPolicy.Problems.HostNotAllowed => "That server is on your own network. Allow it first so Papyra may connect to it.",
        OutboundPolicy.Problems.Unresolvable => "That address could not be found. Check the spelling and that the server is running.",
        _ => "That server address can't be used.",
    };

    private static async Task<IResult> AdminPutNtfy(
        NtfyAdminWrite body, InstanceConfigStore config, OutboundPolicy outbound, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var values = new Dictionary<string, string?>();
        var previousHosts = config.Get(OutboundPolicy.AllowedHostsKey);

        if (body.ServerUrl is not null)
        {
            var url = body.ServerUrl.Trim().TrimEnd('/');
            if (url.Length == 0)
            {
                values[ChannelKeys.NtfyServer] = string.Empty; // back to the public server
            }
            else
            {
                // "Allow it" is the admin's explicit, one-click choice for a server on their own network.
                if (body.AllowHost == true && Uri.TryCreate(url, UriKind.Absolute, out var parsed)
                    && OutboundPolicy.Normalize(parsed.Host) is { } host)
                {
                    var hosts = OutboundPolicy.ParseList(previousHosts);
                    if (!hosts.Contains(host) && hosts.Count < OutboundPolicy.MaxAllowedHosts)
                    {
                        hosts.Add(host);
                        await config.SetAsync(new Dictionary<string, string?>
                            { [OutboundPolicy.AllowedHostsKey] = string.Join('\n', hosts) }, ct);
                    }
                }

                var problem = await outbound.CheckUrlAsync(url, ct);
                if (problem is not null)
                {
                    // Leave the list as it was: a refused server doesn't get its host allowed.
                    await config.SetAsync(new Dictionary<string, string?> { [OutboundPolicy.AllowedHostsKey] = previousHosts }, ct);
                    Uri.TryCreate(url, UriKind.Absolute, out var shown);
                    return Results.BadRequest(new { code = problem, host = shown?.Host, error = Explain(problem) });
                }
                values[ChannelKeys.NtfyServer] = url;
            }
        }

        if (body.Token is not null) values[ChannelKeys.NtfyToken] = body.Token.Trim();
        if (body.Enabled is { } enabled) values[ChannelKeys.Enabled(NotificationCatalog.Ntfy)] = enabled ? "true" : "false";
        if (values.Count > 0) await config.SetAsync(values, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> AdminPutHosts(
        AllowedHostsWrite body, InstanceConfigStore config, CancellationToken ct)
    {
        var hosts = new List<string>();
        foreach (var raw in body.Hosts ?? [])
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            if (OutboundPolicy.Normalize(raw) is not { } host)
                return Results.BadRequest(new { error = $"“{raw.Trim()}” isn't a host name or address. Enter just the name or IP, without https:// or a port." });
            if (!hosts.Contains(host)) hosts.Add(host);
        }
        if (hosts.Count > OutboundPolicy.MaxAllowedHosts)
            return Results.BadRequest(new { error = $"At most {OutboundPolicy.MaxAllowedHosts} hosts." });

        await config.SetAsync(new Dictionary<string, string?> { [OutboundPolicy.AllowedHostsKey] = string.Join('\n', hosts) }, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> AdminTest(
        NtfyTestWrite body, InstanceConfigStore config, NtfyChannel ntfy, SecretBox secrets, CancellationToken ct)
    {
        var topic = body.Topic?.Trim();
        if (string.IsNullOrEmpty(topic) || !TopicPattern().IsMatch(topic))
            return Results.BadRequest(new { error = "Enter a topic: letters, digits, - and _ only." });

        await config.EnsureLoadedAsync(ct);
        var probe = new ChannelDestination { Channel = NotificationCatalog.Ntfy, SecretSealed = secrets.Seal(topic) };
        var result = await ntfy.SendAsync(probe,
            new ChannelMessage("channels.test", "Papyra test: ntfy is connected.", null), ct);
        return Results.Ok(new { ok = result.Outcome == ChannelOutcome.Sent, error = result.Error });
    }

    // ── A person ────────────────────────────────────────────────────────────────

    private static async Task<IResult> Setup(
        NtfySetupWrite body, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config,
        NtfyChannel ntfy, SecretBox secrets, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (!ntfy.IsAvailable(config))
            return Results.Json(new { error = "ntfy isn't turned on for this Papyra. Ask an administrator." }, statusCode: 409);

        var topic = body.Topic?.Trim();
        if (string.IsNullOrEmpty(topic)) topic = NewTopic();
        else if (!TopicPattern().IsMatch(topic))
            return Results.BadRequest(new { error = "A topic can use letters, digits, - and _ (up to 64 characters)." });

        var uid = Me(user);
        // One topic per person: connecting again replaces it, and what was waiting for the old one goes.
        var old = await db.ChannelDestinations.Where(d => d.UserId == uid && d.Channel == NotificationCatalog.Ntfy).ToListAsync(ct);
        foreach (var d in old)
            await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.RemoveRange(old);

        var server = NtfyChannel.ServerUrl(config);
        var destination = new ChannelDestination
        {
            UserId = uid, Channel = NotificationCatalog.Ntfy, Kind = "topic",
            SecretSealed = secrets.Seal(topic),
            Label = $"ntfy · {new Uri(server).Host}",
            Verified = false, Enabled = true, CreatedUtc = DateTime.UtcNow,
        };
        db.ChannelDestinations.Add(destination);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            destination.Id, topic, subscribeUrl = $"{server}/{topic}",
            weakTopic = topic.Length < StrongTopicLength,
        });
    }

    private static async Task<IResult> Address(
        int id, ClaimsPrincipal user, AppDbContext db, InstanceConfigStore config, SecretBox secrets, CancellationToken ct)
    {
        var uid = Me(user);
        var d = await db.ChannelDestinations.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && x.UserId == uid && x.Channel == NotificationCatalog.Ntfy, ct);
        if (d is null) return Results.NotFound();
        var topic = secrets.Open(d.SecretSealed, "A saved ntfy topic");
        if (string.IsNullOrEmpty(topic)) return Results.NotFound();

        await config.EnsureLoadedAsync(ct);
        return Results.Ok(new { topic, subscribeUrl = $"{NtfyChannel.ServerUrl(config)}/{topic}" });
    }

    // 24 characters of a 32-letter alphabet: 120 bits, which is what keeps the topic private.
    private static string NewTopic()
    {
        const string alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        var chars = new char[24];
        for (var i = 0; i < chars.Length; i++) chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        return "papyra-" + new string(chars);
    }
}
