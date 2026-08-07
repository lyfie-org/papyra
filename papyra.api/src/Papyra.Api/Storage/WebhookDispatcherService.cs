using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// The events a webhook can subscribe to.
public static class WebhookEvents
{
    public const string NoteCreated = "NoteCreated";
    public const string TagAdded = "TagAdded";
    public const string PinToggled = "PinToggled";

    public static readonly string[] All = [NoteCreated, TagAdded, PinToggled];
}

// Delivers note events to a user's registered webhooks. Events are queued off the
// request thread; the worker looks up matching webhooks and POSTs an HMAC-SHA256
// signed JSON payload to each. Best-effort: a failed delivery is logged, not retried
// (the filesystem stays the source of truth regardless).
//
// Note: webhook targets are the authenticated user's own deliberate configuration
// (often an internal automation endpoint), so — unlike the web archiver, which
// fetches attacker-controllable URLs — internal targets are permitted; only the
// scheme is validated (at registration).
public sealed class WebhookDispatcherService : BackgroundService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    private readonly Channel<Delivery> _queue = Channel.CreateUnbounded<Delivery>();
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<WebhookDispatcherService> _logger;

    public WebhookDispatcherService(IServiceScopeFactory scopes, ILogger<WebhookDispatcherService> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    private readonly record struct Delivery(int UserId, string Event, string PayloadJson);

    // Queue an event for the given user. Payload is serialized here so the exact
    // bytes we sign are the exact bytes we send.
    public void Enqueue(string userId, string eventName, object payload)
    {
        if (!int.TryParse(userId, out var uid)) return;
        var json = JsonSerializer.Serialize(payload);
        _queue.Writer.TryWrite(new Delivery(uid, eventName, json));
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var delivery in _queue.Reader.ReadAllAsync(ct))
        {
            try { await DispatchAsync(delivery, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Webhook dispatch failed for {Event}", delivery.Event); }
        }
    }

    private async Task DispatchAsync(Delivery delivery, CancellationToken ct)
    {
        List<Webhook> hooks;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            hooks = await db.Webhooks
                .Where(w => w.UserId == delivery.UserId && w.TriggerEvent == delivery.Event)
                .ToListAsync(ct);
        }
        if (hooks.Count == 0) return;

        var signaturePayload = delivery.PayloadJson;
        foreach (var hook in hooks)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, hook.WebhookUrl)
                {
                    Content = new StringContent(signaturePayload, Encoding.UTF8, "application/json"),
                };
                req.Headers.TryAddWithoutValidation("X-Papyra-Event", delivery.Event);
                req.Headers.TryAddWithoutValidation("X-Papyra-Signature", ComputeSignature(hook.SecretKey, signaturePayload));

                using var resp = await Http.SendAsync(req, ct);
                if (!resp.IsSuccessStatusCode)
                    _logger.LogInformation("Webhook {Id} → {Status}", hook.Id, (int)resp.StatusCode);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Webhook {Id} delivery failed", hook.Id);
            }
        }
    }

    // HMAC-SHA256 of the body under the shared secret, hex-encoded — the receiver
    // recomputes it to verify the payload came from Papyra and wasn't tampered with.
    internal static string ComputeSignature(string secret, string body)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret ?? string.Empty), Encoding.UTF8.GetBytes(body));
        return "sha256=" + Convert.ToHexString(mac).ToLowerInvariant();
    }
}
