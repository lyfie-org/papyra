using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Features;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// "Download .md" for one note. A note names its pictures only by name
/// (<c>![[image-db412d.png]]</c>), so a download of the text alone arrived with
/// every embed broken. A note with attachments now comes as a zip holding the
/// text and the files; one without stays a plain .md.
/// </summary>
public sealed class NoteExportTests
{
    private const string Pw = "hunter2!";

    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    [Fact]
    public async Task NoteWithoutAttachments_DownloadsAsPlainMarkdown()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteNoteAsync(owner, "n1", "Plain words, no pictures.", title: "Groceries", tags: ["home"]);

            var res = await owner.GetAsync("/api/notes/n1/export");

            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("text/markdown", res.Content.Headers.ContentType?.MediaType);
            Assert.Equal("Groceries.md", FileName(res));
            var text = await res.Content.ReadAsStringAsync();
            Assert.StartsWith("---\ntitle: \"Groceries\"\ntags: [\"home\"]\n---\n", text);
            Assert.EndsWith("Plain words, no pictures.", text);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NoteWithPictures_DownloadsAsZip_WithJustThePicturesItEmbeds()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var used = await UploadAsync(owner, Png, "used.png");
            var unused = await UploadAsync(owner, Png.Concat(new byte[] { 0 }).ToArray(), "unused.png");
            await WriteNoteAsync(owner, "n1", $"Before ![[{used}]] after ![[missing-file.png]] and ![[{used}|200]]", title: "Trip: day/1");
            await WriteNoteAsync(owner, "n2", $"![[{unused}]]");

            var res = await owner.GetAsync("/api/notes/n1/export");

            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("application/zip", res.Content.Headers.ContentType?.MediaType);
            // The title is made safe as a file name.
            Assert.Equal("Trip day 1.zip", FileName(res));
            using var zip = new ZipArchive(await res.Content.ReadAsStreamAsync());
            Assert.Equal(["Trip day 1.md", $"media/{used}"], zip.Entries.Select(e => e.FullName).Order(StringComparer.Ordinal).ToArray());
            Assert.Contains($"![[{used}]]", Read(zip, "Trip day 1.md"));
            Assert.Equal(Png, ReadBytes(zip, $"media/{used}"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LockedNote_IsRefused_AndUnknownIsNotFound()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var pic = await UploadAsync(owner, Png, "secret.png");
            await WriteNoteAsync(owner, "s1", $"![[{pic}]]", secure: true);

            var locked = await owner.GetAsync("/api/notes/s1/export");
            Assert.Equal(HttpStatusCode.Unauthorized, locked.StatusCode);
            Assert.Contains("locked", await locked.Content.ReadAsStringAsync());
            Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/api/notes/nope/export")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/api/notes/s1/export")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task NotesAreYourOwn_NoOneElsesDownloadsThrough_ThisRoute()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteNoteAsync(owner, "n1", "mine");

            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync("/api/notes/n1/export")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SharedNote_DownloadsWithYourTags_AndOnlyItsOwnPictures()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            var carl = await MemberAsync(factory, owner, "carl");
            var shared = await UploadAsync(owner, Png, "shared.png");
            var other = await UploadAsync(owner, Png.Concat(new byte[] { 0 }).ToArray(), "other.png");
            await WriteNoteAsync(owner, "n1", $"![[{shared}]]", title: "Shared one", tags: ["owners-tag"]);
            await WriteNoteAsync(owner, "n2", $"![[{other}]]");
            var shareId = await GrantAsync(owner, "n1", "bea");
            Assert.Equal(HttpStatusCode.OK, (await bea.PutAsJsonAsync($"/api/shares/incoming/{shareId}/tags", new { tags = new[] { "mine" } })).StatusCode);

            var res = await bea.GetAsync($"/api/shares/incoming/{shareId}/export");

            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("Shared one.zip", FileName(res));
            using var zip = new ZipArchive(await res.Content.ReadAsStreamAsync());
            Assert.Equal(2, zip.Entries.Count);
            var text = Read(zip, "Shared one.md");
            Assert.Contains("tags: [\"mine\"]", text);
            Assert.DoesNotContain("owners-tag", text);
            Assert.Equal(Png, ReadBytes(zip, $"media/{shared}"));

            // Someone it was not shared with has no such share.
            Assert.Equal(HttpStatusCode.NotFound, (await carl.GetAsync($"/api/shares/incoming/{shareId}/export")).StatusCode);

            // Locked by the owner since: nothing leaves.
            await WriteNoteAsync(owner, "n1", $"![[{shared}]]", title: "Shared one", secure: true);
            Assert.Equal(HttpStatusCode.Gone, (await bea.GetAsync($"/api/shares/incoming/{shareId}/export")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Theory]
    [InlineData("Plain title", "Plain title")]
    [InlineData("  a/b\\c:d*e?f\"g<h>i|j  ", "a b c d e f g h i j")]
    [InlineData("", "Untitled")]
    [InlineData("///", "Untitled")]
    public void FileBase_MakesTheTitleSafe(string title, string expected) =>
        Assert.Equal(expected, NoteExportEndpoints.FileBase(title));

    [Fact]
    public void FileBase_IsAtMost80Long() =>
        Assert.Equal(80, NoteExportEndpoints.FileBase(new string('x', 200)).Length);

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string FileName(HttpResponseMessage res) =>
        res.Content.Headers.ContentDisposition?.FileNameStar ?? res.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? "";

    private static string Read(ZipArchive zip, string name) => Encoding.UTF8.GetString(ReadBytes(zip, name));

    private static byte[] ReadBytes(ZipArchive zip, string name)
    {
        using var s = zip.GetEntry(name)!.Open();
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-noteexport-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> OwnerAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
        await TestAuth.SetVaultPinAsync(client, Pw);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"))).StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static async Task<string> UploadAsync(HttpClient client, byte[] bytes, string name)
    {
        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", name } };
        var res = await client.PostAsync("/api/media/upload", form);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("filename").GetString()!;
    }

    private static async Task WriteNoteAsync(
        HttpClient client, string id, string body, string title = "N", string[]? tags = null, bool secure = false) =>
        Assert.True((await client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            title, tags?.ToList(), null, false, false, body, Kind: null, Secure: secure))).IsSuccessStatusCode);

    private static async Task<int> GrantAsync(HttpClient owner, string noteId, string username)
    {
        var res = await owner.PostAsJsonAsync($"/api/notes/{noteId}/shares", new ShareWrite(
            Kind: "user", Access: "view", GranteeUsername: username, ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }
}
