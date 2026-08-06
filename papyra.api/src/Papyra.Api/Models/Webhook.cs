namespace Papyra.Api.Models;

// A user-registered outbound webhook: when TriggerEvent fires for one of their
// notes, the dispatcher POSTs an HMAC-signed JSON payload to WebhookUrl. SecretKey
// is stored in the clear because HMAC signing needs the raw key (it's a shared
// secret with the receiver, not a credential we authenticate against).
public class Webhook
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public string TriggerEvent { get; set; } = string.Empty;
    public string WebhookUrl { get; set; } = string.Empty;
    public string SecretKey { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
}
