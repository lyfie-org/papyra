namespace Papyra.Api.Models;

public sealed class ShareRecord
{
    public required string ShareId    { get; init; }
    public required string NoteId     { get; set; }
    public required string OwnerId    { get; set; }
    /// <summary>Grantee username (lowercase). Null for public links.</summary>
    public string?         Grantee    { get; set; }
    /// <summary>"read" or "write"</summary>
    public string          Permission { get; set; } = "read";
    public DateTime?       ExpiresAt  { get; set; }
    /// <summary>HMAC-signed public link token. Non-null only for public-link shares.</summary>
    public string?         PublicToken { get; set; }
    public DateTime        CreatedAt  { get; init; } = DateTime.UtcNow;
}
