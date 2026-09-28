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

    // The authenticator each client's setup enrolled, for tests that later need a code.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<HttpClient, string> Secrets = new();

    /// <summary>
    /// POST /api/auth/setup the way the wizard does: an authenticator is
    /// compulsory, so one is enrolled (a fresh secret and its current code)
    /// unless the request already carries its own.
    /// </summary>
    public static Task<HttpResponseMessage> PostSetupAsync(this HttpClient client, SetupRequest body)
    {
        if (string.IsNullOrEmpty(body.TotpSecret))
        {
            var secret = Papyra.Api.Security.Totp.NewSecret();
            Secrets.AddOrUpdate(client, secret);
            body = body with { TotpSecret = secret, TotpCode = CodeFor(secret) };
        }
        return client.PostAsJsonAsync("/api/auth/setup", body);
    }

    /// <summary>A fresh authenticator code for the account this client set up (the next step, so it's never a replay).</summary>
    public static string TotpCode(HttpClient client) =>
        Secrets.TryGetValue(client, out var secret) ? CodeFor(secret, 1) : throw new InvalidOperationException("This client didn't run setup.");

    private static string CodeFor(string secret, int offsetSteps = 0) =>
        Papyra.Api.Security.Totp.CodeAt(Papyra.Api.Security.Totp.Base32Decode(secret),
            Papyra.Api.Security.Totp.StepAt(DateTimeOffset.UtcNow) + offsetSteps);
}
