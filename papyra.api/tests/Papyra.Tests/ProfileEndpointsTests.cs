using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Self-service profile edits: username, display name, email, picture removal.
// A rename is the risky one — it must keep the session working, keep everything
// the user owns, refuse names that would collide or could never be @mentioned.
public sealed class ProfileEndpointsTests
{
    private static async Task InApp(Func<HttpClient, string, string, WebApplicationFactory<Program>, Task> test)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "admin@example.com", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var uid = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32().ToString();
            await test(client, uid, dir, factory);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    // With no mail configured, moving the email needs the account password.
    private static Task<HttpResponseMessage> Put(HttpClient c, string? username = null, string? name = null, string? email = null)
        => c.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(name, email, username, CurrentPassword: "hunter2!"));

    private static async Task<JsonElement> Me(HttpClient c)
        => await c.GetFromJsonAsync<JsonElement>("/api/auth/me");

    private static async Task<string> ErrorField(HttpResponseMessage res)
        => (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("field").GetString()!;

    [Fact]
    public Task TimeZone_DefaultsToTheServers_IsValidated_AndCanBeCleared() => InApp(async (client, _, _, _) =>
    {
        var me = await Me(client);
        Assert.Equal(JsonValueKind.Null, me.GetProperty("timeZone").ValueKind);
        Assert.False(string.IsNullOrEmpty(me.GetProperty("serverTimeZone").GetString()));

        var bad = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, TimeZone: "Mars/Olympus_Mons"));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("timeZone", await ErrorField(bad));

        var ok = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, TimeZone: "Asia/Kolkata"));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("Asia/Kolkata", (await Me(client)).GetProperty("timeZone").GetString());

        // Blank goes back to following the server.
        await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, TimeZone: ""));
        Assert.Equal(JsonValueKind.Null, (await Me(client)).GetProperty("timeZone").ValueKind);
    });

    [Fact]
    public Task Rename_KeepsTheSession_AndTheNotes() => InApp(async (client, _, _, _) =>
    {
        await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("T", null, null, false, false, "body"));

        var res = await Put(client, username: "burger", name: "Burger Admin", email: "b@example.com");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var me = await Me(client);
        Assert.Equal("burger", me.GetProperty("username").GetString());
        Assert.Equal("Burger Admin", me.GetProperty("name").GetString());
        Assert.Equal("b@example.com", me.GetProperty("email").GetString());

        // Same account, same vault: the note is still there and the session works.
        var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
        Assert.Contains(notes!, n => n.Id == "n1");
    });

    [Fact]
    public Task Rename_NewNameSignsIn_OldNameDoesNot() => InApp(async (client, _, _, factory) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await Put(client, username: "burger")).StatusCode);
        var other = factory.CreateClient();
        var ok = await other.PostAsJsonAsync("/api/auth/login", new { username = "burger", password = "hunter2!" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var old = factory.CreateClient();
        var bad = await old.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "hunter2!" });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
    });

    [Theory]
    [InlineData("a")]              // too short
    [InlineData("bea.")]           // ends on punctuation: @bea. would mention "bea"
    [InlineData(".bea")]
    [InlineData("be a")]
    [InlineData("bea@home")]
    [InlineData("björn")]          // not mentionable
    [InlineData("")]
    public Task Rename_RefusesUnmentionableNames(string bad) => InApp(async (client, _, _, _) =>
    {
        var res = await Put(client, username: bad);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("username", await ErrorField(res));
        Assert.Equal("admin", (await Me(client)).GetProperty("username").GetString());
    });

    [Theory]
    [InlineData("bea")]
    [InlineData("Bea_2.0-x")]
    [InlineData("b1")]
    public void UsernameRule_AcceptsNormalNames(string ok) => Assert.Null(ProfileRules.UsernameProblem(ok));

    [Fact]
    public Task Rename_RefusesATakenName_CaseInsensitively() => InApp(async (client, _, _, _) =>
    {
        var provision = await client.PostAsJsonAsync("/api/auth/users",
            new ProvisionRequest("Bea", "Bea", "bea@example.com", "hunter2!x", "User", false));
        Assert.True(provision.IsSuccessStatusCode, await provision.Content.ReadAsStringAsync());

        var res = await Put(client, username: "bea");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("username", await ErrorField(res));

        var email = await Put(client, email: "BEA@example.com");
        Assert.Equal(HttpStatusCode.Conflict, email.StatusCode);
        Assert.Equal("email", await ErrorField(email));
    });

    [Fact]
    public Task SameName_DifferentCase_IsARename_NotAConflictWithSelf() => InApp(async (client, _, _, _) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await Put(client, username: "Admin")).StatusCode);
        Assert.Equal("Admin", (await Me(client)).GetProperty("username").GetString());
    });

    [Theory]
    [InlineData("not-an-email")]
    [InlineData("a@b")]
    [InlineData("a@b.com, c@d.com")]
    [InlineData("Bea <bea@example.com>")]
    public Task Email_RefusesMalformed(string bad) => InApp(async (client, _, _, _) =>
    {
        var res = await Put(client, email: bad);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("email", await ErrorField(res));
    });

    [Fact]
    public Task OmittedFields_AreLeftAlone_BlankEmailClears_BlankNameFallsBack() => InApp(async (client, _, _, _) =>
    {
        Assert.Equal(HttpStatusCode.OK, (await Put(client, name: "Only name")).StatusCode);
        var me = await Me(client);
        Assert.Equal("admin", me.GetProperty("username").GetString());
        Assert.Equal("admin@example.com", me.GetProperty("email").GetString());

        Assert.Equal(HttpStatusCode.OK, (await Put(client, name: "  ", email: "")).StatusCode);
        me = await Me(client);
        Assert.Equal("admin", me.GetProperty("name").GetString());
        Assert.Equal("", me.GetProperty("email").GetString());
    });

    [Fact]
    public Task AvatarFollowsARename_AndCanBeRemoved() => InApp(async (client, _, _, _) =>
    {
        // Smallest valid PNG (1×1).
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
        using (var form = new MultipartFormDataContent())
        {
            form.Add(new ByteArrayContent(png), "file", "a.png");
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/auth/avatar", form)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.OK, (await Put(client, username: "burger")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/avatar/burger")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/auth/avatar/admin")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/auth/avatar")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/auth/avatar")).StatusCode);
    });
    [Fact]
    public Task EmailChange_NeedsProof_FromTheAccount() => InApp(async (client, _, _, _) =>
    {
        // No code (mail is off here) and no password: refused, address unchanged.
        var bare = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, "new@example.com"));
        Assert.Equal(HttpStatusCode.PreconditionRequired, bare.StatusCode);
        Assert.Equal("currentPassword", await ErrorField(bare));

        var wrong = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, "new@example.com", CurrentPassword: "nope"));
        Assert.Equal(HttpStatusCode.PreconditionRequired, wrong.StatusCode);
        Assert.Equal("admin@example.com", (await Me(client)).GetProperty("email").GetString());

        // Asking for a code says a password is what counts on this server.
        var code = await client.PostAsJsonAsync("/api/auth/email/code", new EmailCodeRequest("new@example.com"));
        Assert.Equal(HttpStatusCode.OK, code.StatusCode);
        Assert.True((await code.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("passwordRequired").GetBoolean());

        Assert.Equal(HttpStatusCode.OK, (await Put(client, email: "new@example.com")).StatusCode);
        Assert.Equal("new@example.com", (await Me(client)).GetProperty("email").GetString());

        // Same address, any case: not a change, nothing to prove.
        var same = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest("Admin", "NEW@example.com"));
        Assert.Equal(HttpStatusCode.OK, same.StatusCode);
    });

    [Fact]
    public Task UsernameAvailability_IsPerInstance_AndCaseInsensitive() => InApp(async (client, _, _, _) =>
    {
        var provision = await client.PostAsJsonAsync("/api/auth/users",
            new ProvisionRequest("Bea", "Bea", "bea@example.com", "hunter2!x", "User", false));
        Assert.True(provision.IsSuccessStatusCode);

        async Task<JsonElement> Check(string n) => await client.GetFromJsonAsync<JsonElement>($"/api/auth/username-available?name={n}");
        Assert.False((await Check("bea")).GetProperty("available").GetBoolean());
        Assert.True((await Check("admin")).GetProperty("available").GetBoolean()); // your own name
        Assert.True((await Check("someone")).GetProperty("available").GetBoolean());
        var bad = await Check("bea.");
        Assert.False(bad.GetProperty("available").GetBoolean());
        Assert.False(string.IsNullOrEmpty(bad.GetProperty("problem").GetString()));
    });

    [Fact]
    public Task Theme_IsStoredOnTheAccount_AndValidated() => InApp(async (client, _, _, factory) =>
    {
        Assert.Equal(JsonValueKind.Null, (await Me(client)).GetProperty("theme").ValueKind);
        var bad = await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, Theme: "purple"));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(null, null, Theme: "dark"))).StatusCode);

        // A new browser signing in gets it straight away.
        var other = factory.CreateClient();
        var login = await other.PostAsJsonAsync("/api/auth/login", new { username = "admin", password = "hunter2!" });
        Assert.Equal("dark", (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("theme").GetString());
        Assert.Equal("dark", (await Me(other)).GetProperty("theme").GetString());
    });
}
