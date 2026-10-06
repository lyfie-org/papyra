using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Papyra.Api.Security;

namespace Papyra.Tests;

internal static class TestAuth
{
    /// <summary>
    /// An admin-provisioned account carries MustChangePassword, so until its owner
    /// picks a password every other endpoint answers 403. A test that wants to act
    /// as that user has to do what the user would: set a password (re-using the
    /// same one keeps the rest of the test's logins unchanged — the point is
    /// clearing the flag, not the value), then set up the authenticator every
    /// account must have.
    /// </summary>
    public static async Task CompleteForcedPasswordChangeAsync(HttpClient client, string password)
    {
        var res = await client.PostAsJsonAsync("/api/auth/password", new { current = password, next = password });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        await EnrolTotpAsync(client, password);
    }

    /// <summary>
    /// Set up the authenticator for the signed-in account (its test secret, see <see cref="SecretFor"/>).
    /// The password is only for the settings flow; the sign-in gate takes none.
    /// </summary>
    public static async Task EnrolTotpAsync(HttpClient client, string? password = null)
    {
        var me = await client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        if (me.GetProperty("totpEnabled").GetBoolean()) return;
        var secret = SecretFor(me.GetProperty("username").GetString()!);
        var res = await client.PostAsJsonAsync("/api/auth/totp", new { secret, code = await FreshCodeAsync(secret, -1), password });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
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
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("unlockToken").GetString()!;
    }

    /// <summary>
    /// Each username's authenticator secret in tests — derived from the name, so
    /// any client (a second browser, a fresh login) can produce its codes without
    /// the test threading the secret through.
    /// </summary>
    public static string SecretFor(string username) =>
        Totp.Base32Encode(SHA1.HashData(Encoding.UTF8.GetBytes("papyra-test:" + username.Trim().ToLowerInvariant())));

    /// <summary>
    /// POST /api/auth/setup the way the wizard does: an authenticator is
    /// compulsory, so the username's test secret is enrolled unless the request
    /// carries its own. It spends the previous time step's code, leaving this
    /// step's and the next one's for the test to use.
    /// </summary>
    public static async Task<HttpResponseMessage> PostSetupAsync(this HttpClient client, SetupRequest body)
    {
        if (string.IsNullOrEmpty(body.TotpSecret))
        {
            await client.GetAsync("/health"); // start the app first, so the code can't go stale while it boots
            var secret = SecretFor(body.Username ?? string.Empty);
            body = body with { TotpSecret = secret, TotpCode = await FreshCodeAsync(secret, -1) };
        }
        return await client.PostAsJsonAsync("/api/auth/setup", body);
    }

    /// <summary>
    /// Sign in with a password, answering two-step sign-in with the account's
    /// test code when asked. Any other response comes back as it was.
    /// </summary>
    public static async Task<HttpResponseMessage> LoginAsync(this HttpClient client, string username, string password, bool remember = false,
        string? enrolledAs = null)
    {
        var res = await client.PostAsJsonAsync("/api/auth/login", new { username, password, remember });
        if (!res.IsSuccessStatusCode) return res;
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        if (!body.TryGetProperty("twoFactorRequired", out var needed) || !needed.GetBoolean()) return res;
        var ticket = body.GetProperty("ticket").GetString();
        return await client.PostAsJsonAsync("/api/auth/login/2fa", new { ticket, code = NextCode(client, enrolledAs ?? username) });
    }

    /// <summary>A code for the named account on this client's server.</summary>
    public static string TotpCode(HttpClient client, string username = "admin") => NextCode(client, username);

    /// <summary>A code for a step that asks for one, from the signed-in account's test authenticator.</summary>
    public static async Task<string> CodeAsync(HttpClient client)
    {
        var me = await client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        return NextCode(client, me.GetProperty("username").GetString()!);
    }

    // Codes are single-use per time step, per server. Hand out this step's,
    // then the next one's; a test that needs a third inside 30 seconds would
    // have to wait for the clock. Tracked per test server (tests run in parallel
    // and all call their admin "admin"), found through the client's handler chain.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, Dictionary<string, long>> Used = new();

    private static object ServerOf(HttpClient client)
    {
        object? handler = typeof(HttpMessageInvoker)
            .GetField("_handler", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
            .GetValue(client);
        while (handler is DelegatingHandler d && d.InnerHandler is not null) handler = d.InnerHandler;
        var server = handler?.GetType()
            .GetField("_application", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            ?.GetValue(handler);
        return server ?? handler ?? client;
    }

    private static string NextCode(HttpClient client, string username)
    {
        var used = Used.GetOrCreateValue(ServerOf(client));
        var now = Totp.StepAt(DateTimeOffset.UtcNow);
        long step;
        lock (used)
        {
            // Setup and enrolment spent the step before this one (see PostSetupAsync).
            var last = used.TryGetValue(username, out var l) ? l : now - 1;
            step = Math.Max(last + 1, now);
            if (step > now + 1)
                throw new InvalidOperationException($"No unused code left for {username} in this 30-second window.");
            used[username] = step;
        }
        return Totp.CodeAt(Totp.Base32Decode(SecretFor(username)), step);
    }

    // The previous step's code is only good until this step ends. Under a busy
    // parallel run a request can take seconds, so don't start one in a step's
    // last few seconds — wait for the next.
    private static async Task<string> FreshCodeAsync(string secret, int offsetSteps)
    {
        await WaitOutStepEndAsync();
        return Totp.CodeAt(Totp.Base32Decode(secret), Totp.StepAt(DateTimeOffset.UtcNow) + offsetSteps);
    }

    private static async Task WaitOutStepEndAsync()
    {
        var into = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() % (Totp.StepSeconds * 1000L);
        var left = Totp.StepSeconds * 1000L - into;
        if (left < 6000) await Task.Delay(TimeSpan.FromMilliseconds(left + 50));
    }
}
