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
}
