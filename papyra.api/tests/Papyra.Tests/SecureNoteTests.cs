using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class SecureNoteTests
{
    // ── Frontmatter round-trip ──────────────────────────────────────────────────

    [Fact]
    public void Secure_RoundTripsThroughFrontmatter()
    {
        var storage = new MarkdownStorageService();
        var md = storage.Serialize(new Note { Id = "n1", Title = "Vault", Secure = true, Body = "classified" });

        Assert.Contains("secure: true", md);
        Assert.True(storage.Deserialize(md).Secure);
    }

    [Fact]
    public void NonSecureNote_DoesNotStampTheKey()
    {
        var storage = new MarkdownStorageService();
        var md = storage.Serialize(new Note { Id = "n1", Title = "Plain", Body = "hi" });
        Assert.DoesNotContain("secure:", md);
    }

    // ── The server-side gate ────────────────────────────────────────────────────

    [Fact]
    public async Task SecureNote_BodyIsWithheldFromList_AndGatedBehindUnlockToken()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            var put = await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Bank", Tags: null, Color: null, Pinned: false, Archived: false,
                Body: "sort code 00-00-00", Kind: null, Secure: true));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            // The list carries metadata but never the body.
            var listed = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.Equal("Bank", listed.Title);
            Assert.True(listed.Secure);
            Assert.Equal(string.Empty, listed.Body);

            // Without an unlock token the dedicated route refuses.
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/notes/s1/secure")).StatusCode);

            // A forged token is equally refused.
            var forged = new HttpRequestMessage(HttpMethod.Get, "/api/notes/s1/secure");
            forged.Headers.Add("X-Unlock-Token", "deadbeef");
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(forged)).StatusCode);

            // With a genuine token (as a successful WebAuthn assertion would mint) the
            // body is released.
            var token = factory.Services.GetRequiredService<UnlockTokenStore>().Issue("1");
            var unlocked = new HttpRequestMessage(HttpMethod.Get, "/api/notes/s1/secure");
            unlocked.Headers.Add("X-Unlock-Token", token);
            var res = await unlocked.SendVia(client);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var payload = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
            Assert.Equal("sort code 00-00-00", payload.GetProperty("body").GetString());
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task EditingWithoutTheFlag_DoesNotUnlockASecureNote()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);

            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Bank", Tags: null, Color: null, Pinned: false, Archived: false,
                Body: "secret", Kind: null, Secure: true));

            // A client unaware of `secure` edits the note — the lock must survive.
            await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite(
                Title: "Bank", Tags: null, Color: null, Pinned: true, Archived: false, Body: "secret"));

            var listed = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.True(listed.Secure);
            Assert.Equal(string.Empty, listed.Body);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-secure-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }
}

internal static class HttpRequestMessageExtensions
{
    public static Task<HttpResponseMessage> SendVia(this HttpRequestMessage request, HttpClient client) =>
        client.SendAsync(request);
}
