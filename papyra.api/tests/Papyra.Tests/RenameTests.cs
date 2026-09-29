using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// Labels people put on their own things (devices, authenticators, API keys),
// and an admin correcting someone else's name, username and email.
public sealed class RenameTests
{
    private static async Task WithFreshAppAsync(Func<WebApplicationFactory<Program>, HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-rename-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try { await body(factory, factory.CreateClient()); }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    private static Task<HttpResponseMessage> Rename(HttpClient client, string url, string? name) =>
        client.PutAsJsonAsync(url, new { name });

    [Fact]
    public Task OwnDevicesAuthenticatorsAndKeys_CanBeRenamed() => WithFreshAppAsync(async (factory, admin) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);

        var session = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/sessions")).EnumerateArray().Single().GetProperty("id").GetInt32();
        Assert.Equal(HttpStatusCode.OK, (await Rename(admin, $"/api/auth/sessions/{session}", "Office laptop")).StatusCode);
        Assert.Equal("Office laptop", (await admin.GetFromJsonAsync<JsonElement>("/api/auth/sessions")).EnumerateArray().Single().GetProperty("label").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await Rename(admin, $"/api/auth/sessions/{session}", new string('x', 61))).StatusCode);

        var app = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/totp")).GetProperty("authenticators").EnumerateArray().Single().GetProperty("id").GetInt32();
        Assert.Equal(HttpStatusCode.OK, (await Rename(admin, $"/api/auth/totp/{app}", "Bitwarden")).StatusCode);
        Assert.Equal("Bitwarden", (await admin.GetFromJsonAsync<JsonElement>("/api/auth/totp")).GetProperty("authenticators").EnumerateArray().Single().GetProperty("name").GetString());

        var created = await (await admin.PostAsJsonAsync("/api/keys", new { name = "script", code = await TestAuth.CodeAsync(admin) }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var key = created.GetProperty("id").GetInt32();
        Assert.Equal(HttpStatusCode.OK, (await Rename(admin, $"/api/keys/{key}", "Backup job")).StatusCode);
        Assert.Equal("Backup job", (await admin.GetFromJsonAsync<JsonElement>("/api/keys")).EnumerateArray().Single().GetProperty("name").GetString());

        // Someone else's things are not found, not renamed.
        await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: "bea", Name: "Bea", Email: "bea@example.com", Password: "hunter2!", Role: "User"));
        var bea = factory.CreateClient();
        await bea.LoginAsync("bea", "hunter2!");
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");
        Assert.Equal(HttpStatusCode.NotFound, (await Rename(bea, $"/api/auth/sessions/{session}", "mine")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Rename(bea, $"/api/keys/{key}", "mine")).StatusCode);
    });

    [Fact]
    public Task AnAdminCanCorrectSomeonesDetails_ButNotTheirOwn() => WithFreshAppAsync(async (factory, admin) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: null, Email: "a@b.c", Password: "hunter2!"))).StatusCode);
        var made = await (await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: "bea", Name: "Bea", Email: "bea@example.com", Password: "hunter2!", Role: "User"))).Content.ReadFromJsonAsync<JsonElement>();
        var beaId = made.GetProperty("id").GetInt32();

        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/profile",
            new { name = "Beatrice", username = "beatrice", email = "b@example.com" })).StatusCode);
        var row = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/users")).EnumerateArray().Single(u => u.GetProperty("id").GetInt32() == beaId);
        Assert.Equal("Beatrice", row.GetProperty("name").GetString());
        Assert.Equal("beatrice", row.GetProperty("username").GetString());
        Assert.Equal("b@example.com", row.GetProperty("email").GetString());

        // Collisions and bad shapes are refused.
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/profile", new { username = "ADMIN" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/profile", new { email = "A@B.C" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/auth/users/{beaId}/profile", new { email = "nope" })).StatusCode);

        // Your own email goes through Profile, which asks for a code.
        var me = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/auth/users/{me}/profile", new { email = "x@y.z" })).StatusCode);

        // Admins only.
        var bea = factory.CreateClient();
        await bea.LoginAsync("beatrice", "hunter2!");
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");
        Assert.Equal(HttpStatusCode.Forbidden, (await bea.PutAsJsonAsync($"/api/auth/users/{me}/profile", new { name = "x" })).StatusCode);
    });
}
