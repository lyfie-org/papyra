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

    private static Task<HttpResponseMessage> Put(HttpClient c, string? username = null, string? name = null, string? email = null)
        => c.PutAsJsonAsync("/api/auth/profile", new ProfileRequest(name, email, username));

    private static async Task<JsonElement> Me(HttpClient c)
        => await c.GetFromJsonAsync<JsonElement>("/api/auth/me");

    private static async Task<string> ErrorField(HttpResponseMessage res)
        => (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("field").GetString()!;

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
}
