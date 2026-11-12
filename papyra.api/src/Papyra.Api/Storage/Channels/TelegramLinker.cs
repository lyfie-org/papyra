using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

public sealed record TelegramLink(string Code, string Url, DateTime ExpiresUtc, string BotUsername);

public enum PollResult
{
    /// <summary>Telegram isn't set up (or switched off): nothing to read.</summary>
    Idle,
    /// <summary>Read the bot's messages (there may have been none).</summary>
    Ok,
    /// <summary>Telegram could not be read right now.</summary>
    Error,
    /// <summary>Telegram refused the bot's token.</summary>
    BadToken,
}

/// <summary>
/// Connects and disconnects Telegram chats. A person asks Papyra for a link
/// (<c>https://t.me/&lt;bot&gt;?start=&lt;code&gt;</c>); when they open it and press Start, the bot receives
/// <c>/start &lt;code&gt;</c>, finds whose code it is, and remembers that chat for that account. The code
/// lasts 10 minutes, works once, and only its hash is stored, so a chat can only ever be connected by someone
/// holding a link Papyra made for that account — and the bot says which account, so a link forwarded to the
/// wrong person is noticed. <c>/stop</c> disconnects.
///
/// Papyra only <em>asks</em> Telegram for the bot's messages (a long poll), so it needs no public address.
/// Anything the bot receives other than these commands is ignored without a reply.
/// </summary>
public sealed class TelegramLinker(
    IServiceScopeFactory scopes, InstanceConfigStore config, TelegramApi api, TimeProvider clock, ILogger<TelegramLinker> logger)
{
    public const int CodeMinutes = 10;
    public const int HoldSeconds = 25;
    private const string Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

    /// <summary>Why the last read failed, for the admin screen. Null when it worked.</summary>
    public string? LastError { get; private set; }

    private DateTime Now => clock.GetUtcNow().UtcDateTime;

    public bool IsConfigured =>
        config.GetBool(ChannelKeys.Enabled(NotificationCatalog.Telegram))
        && config.Has(ChannelKeys.TelegramBotToken) && config.Has(ChannelKeys.TelegramBotUsername);

    // ── Person: make a link ─────────────────────────────────────────────────────

    /// <summary>A fresh link for this account. Any earlier code of theirs stops working.</summary>
    public async Task<TelegramLink?> NewLinkAsync(int userId, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (!IsConfigured) return null;

        // 20 letters/digits of a 32-symbol alphabet: 100 bits, and a valid /start parameter.
        var chars = new char[20];
        for (var i = 0; i < chars.Length; i++) chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        var code = new string(chars);
        var expires = Now.AddMinutes(CodeMinutes);

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = Now;
        await db.ChannelLinkCodes
            .Where(c => c.ExpiresUtc < now || (c.UserId == userId && c.Channel == NotificationCatalog.Telegram))
            .ExecuteDeleteAsync(ct);
        db.ChannelLinkCodes.Add(new ChannelLinkCode
        {
            UserId = userId, Channel = NotificationCatalog.Telegram, CodeHash = Hash(code), ExpiresUtc = expires,
        });
        await db.SaveChangesAsync(ct);

        var bot = config.GetOrEmpty(ChannelKeys.TelegramBotUsername);
        return new TelegramLink(code, $"https://t.me/{bot}?start={code}", expires, bot);
    }

    private static string Hash(string code) => LinkCodes.Hash(code);

    // ── Bot: read what people sent ──────────────────────────────────────────────

    /// <summary>One long poll: wait for the bot's messages, act on the ones that matter, remember how far it got.</summary>
    public async Task<PollResult> PollOnceAsync(CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        if (!IsConfigured) { LastError = null; return PollResult.Idle; }

        var token = config.Get(ChannelKeys.TelegramBotToken)!;
        var offset = long.TryParse(config.Get(ChannelKeys.TelegramOffset), out var saved) ? saved : 0;

        var result = await api.GetUpdatesAsync(token, offset, HoldSeconds, ct);
        if (result.Error is not null)
        {
            LastError = result.Error;
            return result.BadToken ? PollResult.BadToken : PollResult.Error;
        }
        LastError = null;
        if (result.Updates.Count == 0) return PollResult.Ok;

        foreach (var update in result.Updates.OrderBy(u => u.UpdateId))
        {
            try { await HandleAsync(update, token, ct); }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                // One message that can't be handled must not hold up the rest, or be read forever.
                logger.LogWarning(ex, "A Telegram message could not be handled");
            }
            offset = Math.Max(offset, update.UpdateId + 1);
        }
        await config.SetAsync(new Dictionary<string, string?> { [ChannelKeys.TelegramOffset] = offset.ToString() }, ct);
        return PollResult.Ok;
    }

    internal async Task HandleAsync(TelegramUpdate update, string token, CancellationToken ct)
    {
        // Only people writing to the bot privately; groups and channels are ignored.
        if (update.ChatType != "private" || update.ChatId is not { } chatId || string.IsNullOrWhiteSpace(update.Text)) return;

        var parts = update.Text.Trim().Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries);
        var command = parts[0].ToLowerInvariant();
        var at = command.IndexOf('@');
        if (at >= 0) command = command[..at];
        var argument = parts.Length > 1 ? parts[1].Trim() : string.Empty;

        switch (command)
        {
            case "/start" when argument.Length > 0:
                await LinkAsync(chatId, update, argument, token, ct);
                break;
            case "/start":
                await ReplyAsync(token, chatId,
                    "To connect Papyra, open Papyra → Settings → Notifications → Telegram and use the link it gives you.", ct);
                break;
            case "/stop":
                await UnlinkAsync(chatId, token, ct);
                break;
        }
    }

    private async Task LinkAsync(long chatId, TelegramUpdate update, string code, string token, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = Now;

        var hash = Hash(code);
        var row = await db.ChannelLinkCodes.FirstOrDefaultAsync(c => c.CodeHash == hash && c.Channel == NotificationCatalog.Telegram, ct);
        var user = row is null || row.ExpiresUtc < now ? null : await db.Users.FindAsync([row.UserId], ct);
        if (row is not null) db.ChannelLinkCodes.Remove(row); // used or expired: gone either way

        if (user is null || user.DisabledUtc is not null)
        {
            await db.SaveChangesAsync(ct);
            await ReplyAsync(token, chatId,
                "That link has expired or was already used. Open Papyra → Settings → Notifications → Telegram and start again.", ct);
            return;
        }

        // One Telegram chat per account: connecting again replaces it, and what was queued for the old one goes.
        var old = await db.ChannelDestinations
            .Where(d => d.UserId == user.Id && d.Channel == NotificationCatalog.Telegram).ToListAsync(ct);
        foreach (var d in old)
            await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.RemoveRange(old);

        var who = !string.IsNullOrWhiteSpace(update.Username) ? "@" + update.Username
            : !string.IsNullOrWhiteSpace(update.FirstName) ? update.FirstName!.Trim() : "chat";
        db.ChannelDestinations.Add(new ChannelDestination
        {
            UserId = user.Id, Channel = NotificationCatalog.Telegram, Kind = TelegramChannel.ChatKind,
            Handle = chatId.ToString(), Label = $"Telegram · {Clip(who, 40)}",
            Verified = true, Enabled = true, CreatedUtc = now,
        });
        await db.SaveChangesAsync(ct);

        await ReplyAsync(token, chatId,
            $"Connected to the Papyra account “{user.Username}”. Your notifications will arrive here. Send /stop to disconnect.", ct);
    }

    private async Task UnlinkAsync(long chatId, string token, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var handle = chatId.ToString();
        var mine = await db.ChannelDestinations
            .Where(d => d.Channel == NotificationCatalog.Telegram && d.Handle == handle).ToListAsync(ct);
        foreach (var d in mine)
            await db.ChannelDeliveries.Where(x => x.DestinationId == d.Id).ExecuteDeleteAsync(ct);
        db.ChannelDestinations.RemoveRange(mine);
        await db.SaveChangesAsync(ct);

        await ReplyAsync(token, chatId,
            mine.Count > 0 ? "Disconnected. Papyra won't send anything here any more." : "This chat isn't connected to Papyra.", ct);
    }

    // A reply that fails (the person already blocked the bot, say) is not worth failing the command over.
    private async Task ReplyAsync(string token, long chatId, string text, CancellationToken ct)
    {
        var result = await api.SendMessageAsync(token, chatId.ToString(), text, ct);
        if (result.Outcome != ChannelOutcome.Sent) logger.LogInformation("A Telegram reply was not delivered: {Error}", result.Error);
    }

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}

/// <summary>Runs <see cref="TelegramLinker.PollOnceAsync"/> for as long as Papyra is up.</summary>
public sealed class TelegramPoller(TelegramLinker linker, ILogger<TelegramPoller> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(15), stop); }
        catch (OperationCanceledException) { return; }

        var failures = 0;
        while (!stop.IsCancellationRequested)
        {
            TimeSpan wait;
            try
            {
                var started = DateTime.UtcNow;
                var result = await linker.PollOnceAsync(stop);
                switch (result)
                {
                    case PollResult.Ok:
                        failures = 0;
                        // The long poll normally holds for many seconds; never spin if it didn't.
                        wait = DateTime.UtcNow - started < TimeSpan.FromSeconds(1) ? TimeSpan.FromSeconds(1) : TimeSpan.Zero;
                        break;
                    case PollResult.BadToken:
                        wait = TimeSpan.FromMinutes(5);
                        break;
                    case PollResult.Error:
                        failures++;
                        wait = TimeSpan.FromSeconds(Math.Min(60, 5 * failures));
                        break;
                    default: // Idle: nothing to read until an admin sets Telegram up
                        failures = 0;
                        wait = TimeSpan.FromSeconds(20);
                        break;
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Reading Telegram's messages failed; trying again shortly");
                failures++;
                wait = TimeSpan.FromSeconds(Math.Min(60, 5 * failures));
            }

            if (wait > TimeSpan.Zero)
            {
                try { await Task.Delay(wait, stop); }
                catch (OperationCanceledException) { return; }
            }
        }
    }
}
