using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

/// <summary>
/// Sends Papyra's notifications to chat services (ntfy, Discord, Telegram…), reliably and out of the
/// request path.
///
/// <see cref="Enqueue"/> is the whole front door: <see cref="EmailSender"/> calls it for every
/// notification, next to the email, so no call site has to know chat channels exist. It only drops a
/// small note in memory. Behind it, one worker decides who gets what: for each person with a verified,
/// switched-on destination whose per-event choice says yes, a row goes into the database (the
/// outbox). It is then sent, retried with a growing wait (and whatever the service asked for), and
/// given up on after a few tries. A destination the service keeps refusing is paused and the person
/// is told once, by email.
///
/// What is sent is chosen per destination: a generic line by default ("You were mentioned in a note",
/// never a name or a title), or the notification's own subject if the person chose "titles". Never a
/// note's text. Critical security notices never come here — they stay email-only.
/// </summary>
public sealed class ChannelDeliveryService : BackgroundService
{
    public const int MaxAttempts = 6;
    public const int PauseAfterFailures = 5;
    public const int MaxPendingPerDestination = 200;
    private const int BatchSize = 50;
    private const int MaxSubject = 200;

    private static readonly TimeSpan[] Backoff =
        [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30), TimeSpan.FromHours(2), TimeSpan.FromHours(6)];
    private static readonly TimeSpan LongestWait = TimeSpan.FromHours(6);
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan KeepFinished = TimeSpan.FromDays(7);

    private sealed record Notice(int UserId, string EventId, string Subject);

    private readonly IServiceScopeFactory _scopes;
    private readonly IServiceProvider _services;
    private readonly InstanceConfigStore _config;
    private readonly TimeProvider _clock;
    private readonly ILogger<ChannelDeliveryService> _logger;
    private readonly Dictionary<string, INotificationChannel> _providers;

    private readonly Channel<Notice> _notices = Channel.CreateBounded<Notice>(
        new BoundedChannelOptions(2000) { FullMode = BoundedChannelFullMode.DropOldest });
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DateTime _lastPrune = DateTime.MinValue;

    public ChannelDeliveryService(
        IServiceScopeFactory scopes, IServiceProvider services, IEnumerable<INotificationChannel> providers,
        InstanceConfigStore config, TimeProvider clock, ILogger<ChannelDeliveryService> logger)
    {
        _scopes = scopes;
        _services = services;
        _config = config;
        _clock = clock;
        _logger = logger;
        _providers = providers.ToDictionary(p => p.Id, StringComparer.Ordinal);
    }

    /// <summary>The chat channels an admin has switched on and set up, in catalog order.</summary>
    public IReadOnlyList<string> AvailableChannels() =>
        NotificationCatalog.Channels.Where(c => _providers.TryGetValue(c, out var p) && p.IsAvailable(_config)).ToList();

    /// <summary>
    /// Offer a notification to the chat channels. Returns at once; nothing here touches the database or
    /// the network. Events that are always-on mail (security notices) or not listed are ignored.
    /// </summary>
    public void Enqueue(int userId, string eventId, string subject)
    {
        if (_providers.Count == 0) return;
        if (NotificationCatalog.Find(eventId) is not { Critical: false, Listed: true }) return;
        if (_notices.Writer.TryWrite(new Notice(userId, eventId, subject ?? string.Empty))) _wake.Release();
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(10), stop); }
        catch (OperationCanceledException) { return; }

        while (!stop.IsCancellationRequested)
        {
            try { await ProcessAsync(stop); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (Exception ex) { _logger.LogWarning(ex, "A pass over the chat notification queue failed; it will be tried again"); }

            try { await _wake.WaitAsync(Tick, stop); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// One pass: turn what was offered into outbox rows, send what is due, tidy up. The worker calls
    /// this in a loop; tests call it directly. Passes never overlap.
    /// </summary>
    public async Task ProcessAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await _config.EnsureLoadedAsync(ct);
            while (_notices.Reader.TryRead(out var notice))
            {
                try { await IngestAsync(notice, ct); }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex) { _logger.LogWarning(ex, "A chat notification could not be queued for {Event}", notice.EventId); }
            }
            await DeliverDueAsync(ct);
            await PruneAsync(ct);
        }
        finally { _gate.Release(); }
    }

    private DateTime Now => _clock.GetUtcNow().UtcDateTime;

    // ── Offered → queued ────────────────────────────────────────────────────────

    private async Task IngestAsync(Notice notice, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == notice.UserId, ct);
        if (user is null || user.DisabledUtc is not null) return;

        var destinations = await db.ChannelDestinations
            .Where(d => d.UserId == user.Id && d.Enabled && d.Verified && d.PausedUtc == null)
            .ToListAsync(ct);
        if (destinations.Count == 0) return;

        var link = PublicLink();
        var now = Now;
        foreach (var destination in destinations)
        {
            if (!_providers.TryGetValue(destination.Channel, out var provider) || !provider.IsAvailable(_config)) continue;
            if (!NotificationPrefs.Wants(user, notice.EventId, destination.Channel)) continue;

            var waiting = await db.ChannelDeliveries.CountAsync(
                d => d.DestinationId == destination.Id && d.Status == ChannelDeliveryStatus.Pending, ct);
            if (waiting >= MaxPendingPerDestination) continue;

            var title = destination.PrivacyTier == ChannelPrivacy.Titles && !string.IsNullOrWhiteSpace(notice.Subject)
                ? Clip(notice.Subject.Trim(), MaxSubject)
                : ChannelCopy.Headline(notice.EventId);

            db.ChannelDeliveries.Add(new ChannelDelivery
            {
                DestinationId = destination.Id, UserId = user.Id, Channel = destination.Channel,
                EventId = notice.EventId, Title = title, Link = link,
                CreatedUtc = now, NextAttemptUtc = now,
            });
        }
        await db.SaveChangesAsync(ct);
    }

    // The app's own address, when the admin has told Papyra it (the same setting email links use).
    // A background pass has no request to read it from, so without one the message has no link.
    private string? PublicLink() =>
        _config.Has(SmtpKeys.PublicUrl) ? _config.GetOrEmpty(SmtpKeys.PublicUrl).TrimEnd('/') + "/?notifications=1" : null;

    // ── Queued → sent ───────────────────────────────────────────────────────────

    private async Task DeliverDueAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var now = Now;
        var due = await db.ChannelDeliveries
            .Where(d => d.Status == ChannelDeliveryStatus.Pending && d.NextAttemptUtc <= now)
            .OrderBy(d => d.Id).Take(BatchSize).ToListAsync(ct);

        foreach (var row in due)
        {
            await DeliverOneAsync(db, row, ct);
            await db.SaveChangesAsync(ct);
        }
    }

    private async Task DeliverOneAsync(AppDbContext db, ChannelDelivery row, CancellationToken ct)
    {
        var destination = await db.ChannelDestinations.FindAsync([row.DestinationId], ct);
        if (destination is null || !destination.Enabled || !destination.Verified || destination.PausedUtc is not null)
        {
            Finish(row, ChannelDeliveryStatus.Dropped, "The destination is gone, off or paused.");
            return;
        }
        if (!_providers.TryGetValue(row.Channel, out var provider) || !provider.IsAvailable(_config))
        {
            Finish(row, ChannelDeliveryStatus.Dropped, "This channel is switched off.");
            return;
        }

        var result = await SendAsync(provider, destination, new ChannelMessage(row.EventId, row.Title, row.Link), ct);
        var now = Now;
        row.Attempts++;

        switch (result.Outcome)
        {
            case ChannelOutcome.Sent:
                Finish(row, ChannelDeliveryStatus.Sent, null);
                destination.LastOkUtc = now;
                destination.LastError = null;
                destination.ConsecutiveFailures = 0;
                break;

            case ChannelOutcome.Rejected:
                Finish(row, ChannelDeliveryStatus.Failed, result.Error);
                await PauseAsync(db, destination, result.Error ?? "The service refused the message.", ct);
                break;

            default:
                destination.LastError = result.Error;
                destination.LastErrorUtc = now;
                if (row.Attempts >= MaxAttempts)
                {
                    Finish(row, ChannelDeliveryStatus.Failed, result.Error);
                    destination.ConsecutiveFailures++;
                    if (destination.ConsecutiveFailures >= PauseAfterFailures)
                        await PauseAsync(db, destination, result.Error ?? "Messages kept failing.", ct);
                }
                else
                {
                    row.LastError = Clip(result.Error ?? "Could not be sent.", 300);
                    var wait = Backoff[Math.Min(row.Attempts - 1, Backoff.Length - 1)];
                    if (result.RetryAfter is { } asked && asked > wait) wait = asked > LongestWait ? LongestWait : asked;
                    row.NextAttemptUtc = now + wait;
                }
                break;
        }
    }

    private async Task<ChannelSendResult> SendAsync(
        INotificationChannel provider, ChannelDestination destination, ChannelMessage message, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(SendTimeout);
        try
        {
            return await provider.SendAsync(destination, message, timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return ChannelSendResult.Retry("The service did not answer in time.");
        }
        catch (Exception ex)
        {
            // The type only: an HTTP library's message can carry the address, and the address is the secret.
            _logger.LogWarning("The {Channel} provider threw {Type}", provider.Id, ex.GetType().Name);
            return ChannelSendResult.Retry("Something went wrong while sending.");
        }
    }

    // The message is done — one way or another. Its text is no longer needed.
    private void Finish(ChannelDelivery row, string status, string? error)
    {
        row.Status = status;
        row.DoneUtc = Now;
        row.LastError = error is null ? null : Clip(error, 300);
        row.Title = string.Empty;
        row.Link = null;
    }

    private async Task PauseAsync(AppDbContext db, ChannelDestination destination, string reason, CancellationToken ct)
    {
        var now = Now;
        destination.PausedUtc = now;
        destination.LastError = Clip(reason, 300);
        destination.LastErrorUtc = now;

        // Whatever else was waiting for it will not be sent.
        var waiting = await db.ChannelDeliveries
            .Where(d => d.DestinationId == destination.Id && d.Status == ChannelDeliveryStatus.Pending)
            .ToListAsync(ct);
        foreach (var other in waiting)
        {
            // The message that caused the pause is already finished in memory (not yet saved).
            if (other.Status != ChannelDeliveryStatus.Pending) continue;
            Finish(other, ChannelDeliveryStatus.Dropped, "The destination was paused.");
        }

        var user = await db.Users.FindAsync([destination.UserId], ct);
        if (user is null) return;
        var name = ChannelName(destination.Channel);
        _services.GetRequiredService<EmailSender>().NotifyInBackground(
            user, NotificationCatalog.ChannelPaused,
            $"Your {name} notifications are paused",
            $"Papyra could not deliver to {destination.Label}: {destination.LastError}\n\n"
            + "Nothing more will be sent there until you fix it. Open Settings → Notifications to check it and turn it back on.");
        _logger.LogWarning("Paused {Channel} notifications for user {User}", destination.Channel, destination.UserId);
    }

    // ── Tidying ─────────────────────────────────────────────────────────────────

    private async Task PruneAsync(CancellationToken ct)
    {
        var now = Now;
        if (now - _lastPrune < TimeSpan.FromHours(1)) return;
        _lastPrune = now;

        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var cutoff = now - KeepFinished;
        await db.ChannelDeliveries
            .Where(d => d.Status != ChannelDeliveryStatus.Pending && d.DoneUtc != null && d.DoneUtc < cutoff)
            .ExecuteDeleteAsync(ct);
    }

    public static string ChannelName(string channel) => channel switch
    {
        NotificationCatalog.Discord => "Discord",
        NotificationCatalog.Telegram => "Telegram",
        NotificationCatalog.Ntfy => "ntfy",
        _ => channel,
    };

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
