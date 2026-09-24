namespace Papyra.Api.Models;

// A registered platform authenticator (Touch ID / Face ID / Windows Hello) bound to
// a user. Only public material is stored — the private key never leaves the device.
// SignCount is the authenticator's replay counter, advanced on every assertion.
public class WebAuthnCredential
{
    public int Id { get; set; }
    public int UserId { get; set; }
    // Base64url of the raw credential id handed back by the authenticator.
    public string CredentialId { get; set; } = string.Empty;
    // Base64 of the COSE public key used to verify assertion signatures.
    public string PublicKey { get; set; } = string.Empty;
    public string? AaGuid { get; set; }
    public uint SignCount { get; set; }
    public string Name { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
    // The relying-party id (host) the credential was created for. A passkey only
    // works on that host, so the device list can say where it applies and an
    // unlock only offers the credentials this host can use. Empty for rows created
    // before this was recorded.
    public string RpId { get; set; } = string.Empty;
}
