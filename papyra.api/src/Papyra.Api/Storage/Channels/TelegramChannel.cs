using Papyra.Api.Models;

namespace Papyra.Api.Storage.Channels;

/// <summary>
/// Sends notifications to Telegram through the admin's bot. The admin gives the bot's token once; a person
/// connects by tapping a link that opens the bot (see <see cref="TelegramLinker"/>), so Papyra learns their
/// chat without anyone typing an id — and the code in the link proves the chat is theirs.
/// </summary>
public sealed class TelegramChannel(InstanceConfigStore config, TelegramApi api) : INotificationChannel
{
    public const string ChatKind = "chat";

    public string Id => NotificationCatalog.Telegram;

    /// <summary>On, with a token the admin saved (which also recorded the bot's name for the link).</summary>
    public bool IsAvailable(InstanceConfigStore store) =>
        store.GetBool(ChannelKeys.Enabled(Id)) && store.Has(ChannelKeys.TelegramBotToken) && store.Has(ChannelKeys.TelegramBotUsername);

    // A chat is proved by the link's code, never by the person saying so.
    public bool CanBeConfirmedByPerson(ChannelDestination destination) => false;

    public async Task<ChannelSendResult> SendAsync(ChannelDestination destination, ChannelMessage message, CancellationToken ct)
    {
        if (destination.Kind != ChatKind || string.IsNullOrWhiteSpace(destination.Handle))
            return ChannelSendResult.Rejected("Telegram isn't connected. Connect it again.");

        await config.EnsureLoadedAsync(ct);
        var token = config.Get(ChannelKeys.TelegramBotToken);
        if (string.IsNullOrEmpty(token))
            return ChannelSendResult.Retry("Telegram isn't set up on this server.");

        // Plain text: nothing in a title can turn into formatting or a button, and a link just becomes tappable.
        var text = string.IsNullOrEmpty(message.Link) ? message.Title : $"{message.Title}\n{message.Link}";
        return await api.SendMessageAsync(token, destination.Handle, text, ct);
    }
}
