using System.Security.Cryptography;
using System.Text;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class WebhookDispatcherServiceTests
{
    [Fact]
    public void ComputeSignature_IsStable_Prefixed_AndSecretSensitive()
    {
        const string body = "{\"event\":\"NoteCreated\"}";
        var sig = WebhookDispatcherService.ComputeSignature("topsecret", body);

        Assert.StartsWith("sha256=", sig);
        Assert.Equal(sig, WebhookDispatcherService.ComputeSignature("topsecret", body)); // deterministic
        Assert.NotEqual(sig, WebhookDispatcherService.ComputeSignature("other", body));  // keyed by secret

        // Matches an independent HMAC-SHA256 (hex, lowercase) — the format a receiver verifies against.
        var expected = "sha256=" + Convert.ToHexString(
            HMACSHA256.HashData(Encoding.UTF8.GetBytes("topsecret"), Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
        Assert.Equal(expected, sig);
    }
}
