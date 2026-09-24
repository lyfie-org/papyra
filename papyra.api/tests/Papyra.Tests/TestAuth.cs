using System.Net;
using System.Net.Http.Json;

namespace Papyra.Tests;

internal static class TestAuth
{
    /// <summary>
    /// An admin-provisioned account carries MustChangePassword, so until its owner
    /// picks a password every other endpoint answers 403. A test that wants to act
    /// as that user has to do what the user would: set a password. Re-using the
    /// same one keeps the rest of the test's logins unchanged — the point is
    /// clearing the flag, not the value.
    /// </summary>
    public static async Task CompleteForcedPasswordChangeAsync(HttpClient client, string password)
    {
        var res = await client.PostAsJsonAsync("/api/auth/password", new { current = password, next = password });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    public const string VaultPin = "480913";

    /// <summary>
    /// A note can only be locked once the account has a vault PIN. Sets one with
    /// the account password (the first-time proof) and returns the unlock token
    /// the server hands back.
    /// </summary>
    public static async Task<string> SetVaultPinAsync(HttpClient client, string password, string pin = VaultPin)
    {
        var res = await client.PostAsJsonAsync("/api/auth/vault/pin", new { pin, password });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return json.GetProperty("unlockToken").GetString()!;
    }
}
