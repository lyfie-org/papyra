namespace Papyra.Api.Storage.Channels;

/// <summary>
/// Lets a self-hoster who sets the chat services up in their compose file (<c>PAPYRA_NTFY_URL</c>,
/// <c>PAPYRA_NTFY_TOKEN</c>, <c>PAPYRA_TELEGRAM_BOT_TOKEN</c>) have them ready on first start, like the SSO
/// settings. It imports once: as soon as the admin has made a choice in the app — on or off — the database is
/// the authority and the variables are ignored. A value that doesn't check out (an address on the home network
/// that isn't on the allowed list, a bot token Telegram refuses) is skipped with a log line that says why,
/// never half-applied. Discord has nothing to import: a person's webhook is theirs, and the admin only
/// switches it on.
/// </summary>
public static class ChannelSeed
{
    public static async Task SeedAsync(
        IConfiguration config, InstanceConfigStore store, OutboundPolicy outbound, TelegramApi telegram,
        ILogger logger, CancellationToken ct)
    {
        await store.EnsureLoadedAsync(ct);
        var values = new Dictionary<string, string?>();

        // ntfy: an address and/or an access token.
        var url = config["Channels:Ntfy:Url"]?.Trim().TrimEnd('/');
        var ntfyToken = config["Channels:Ntfy:Token"]?.Trim();
        if ((!string.IsNullOrEmpty(url) || !string.IsNullOrEmpty(ntfyToken))
            && store.Get(ChannelKeys.Enabled(NotificationCatalog.Ntfy)) is null)
        {
            var problem = string.IsNullOrEmpty(url) ? null : await outbound.CheckUrlAsync(url, ct);
            if (problem is null)
            {
                if (!string.IsNullOrEmpty(url)) values[ChannelKeys.NtfyServer] = url;
                if (!string.IsNullOrEmpty(ntfyToken)) values[ChannelKeys.NtfyToken] = ntfyToken;
                values[ChannelKeys.Enabled(NotificationCatalog.Ntfy)] = "true";
            }
            else
            {
                logger.LogWarning(
                    "The ntfy address in the environment was not used ({Code}). Fix it, or set ntfy up under Settings → Chat notifications; "
                    + "an address on your own network must be on the allowed list first", problem);
            }
        }

        // Telegram: the bot's token, checked with Telegram so the bot's name is known for the links.
        var botToken = config["Channels:Telegram:BotToken"]?.Trim();
        if (!string.IsNullOrEmpty(botToken) && store.Get(ChannelKeys.Enabled(NotificationCatalog.Telegram)) is null)
        {
            var (bot, error) = await telegram.GetMeAsync(botToken, ct);
            if (bot is not null)
            {
                values[ChannelKeys.TelegramBotToken] = botToken;
                values[ChannelKeys.TelegramBotUsername] = bot.Username;
                values[ChannelKeys.Enabled(NotificationCatalog.Telegram)] = "true";
            }
            else
            {
                logger.LogWarning("The Telegram bot token in the environment was not used: {Error}", error);
            }
        }

        if (values.Count == 0) return;
        await store.SetAsync(values, ct);
        logger.LogInformation("Imported chat notification settings from the environment: {Count} value(s)", values.Count);
    }
}
