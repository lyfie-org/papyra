using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Papyra.Api.Collab;

/// <summary>
/// A short-lived, HMAC-signed grant to join one note's live room. Minted only
/// after <see cref="CollabAccess"/> has checked the caller may open the note;
/// the engine trusts nothing else. Wire format must match
/// papyra.collab/src/ticket.ts byte for byte:
/// <c>base64url(utf8 JSON) + "." + base64url(HMAC-SHA256(secret, payloadPart))</c>.
/// </summary>
public sealed record CollabTicket(
    [property: JsonPropertyName("v")] int V,
    [property: JsonPropertyName("uid")] int Uid,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("owner")] int Owner,
    [property: JsonPropertyName("note")] string Note,
    [property: JsonPropertyName("access")] string Access,
    // Issued-at in unix milliseconds: a kick refuses tickets minted before it.
    [property: JsonPropertyName("iat")] long Iat,
    // Expiry in unix seconds.
    [property: JsonPropertyName("exp")] long Exp)
{
    /// <summary>The engine's document name for a note: <c>{ownerId}:{noteId}</c> (ids are per vault).</summary>
    public static string RoomName(int owner, string note) => $"{owner}:{note}";

    public static string Mint(string secret, CollabTicket ticket)
    {
        var payloadPart = Base64Url(JsonSerializer.SerializeToUtf8Bytes(ticket));
        var signature = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.ASCII.GetBytes(payloadPart));
        return $"{payloadPart}.{Base64Url(signature)}";
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>Content hash the engine echoes back as a save's <c>baseHash</c>.</summary>
public static class CollabHash
{
    public static string Of(string body) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
}
