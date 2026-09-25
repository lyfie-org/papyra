using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Multi-select acts on many notes in one request. What matters to the person
/// holding the selection: every note they picked gets the same outcome, a note
/// that can't be touched says why without sinking the rest, nobody else's notes
/// are reachable through it, and a locked note's body survives — the client
/// never had it to send back.
/// </summary>
public sealed class BulkActionsTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-bulk-" + Guid.NewGuid().ToString("N"));
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
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(
        WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, provision.StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, Pw))).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static async Task WriteAsync(HttpClient client, string id, string body = "body",
        bool pinned = false, bool? secure = null, string title = "T")
    {
        var res = await client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: title, Tags: null, Color: null, Pinned: pinned, Archived: false,
            Body: body, Kind: null, Secure: secure));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    private static async Task<JsonElement> BulkAsync(HttpClient client, string action, params string[] ids)
    {
        var res = await client.PostAsJsonAsync("/api/notes/bulk", new { ids, action });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static Dictionary<string, string> Statuses(JsonElement result) =>
        result.GetProperty("results").EnumerateArray()
            .ToDictionary(r => r.GetProperty("id").GetString()!, r => r.GetProperty("status").GetString()!);

    private static async Task<List<Note>> NotesAsync(HttpClient client) =>
        await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [];

    [Fact]
    public async Task BulkPin_ChangesEach_ReportsUnchangedAndMissing_AndLeavesBodiesAlone()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            await WriteAsync(client, "a", body: "alpha body");
            await WriteAsync(client, "b", body: "beta body");
            await WriteAsync(client, "c", body: "gamma body", pinned: true);

            // Duplicates and blanks in the selection are harmless; a stranger id is reported.
            var result = await BulkAsync(client, "pin", "a", "b", "b", "c", "", "ghost");
            Assert.Equal(2, result.GetProperty("changed").GetInt32());
            var s = Statuses(result);
            Assert.Equal("changed", s["a"]);
            Assert.Equal("changed", s["b"]);
            Assert.Equal("unchanged", s["c"]);
            Assert.Equal("notFound", s["ghost"]);
            Assert.Equal(4, s.Count);

            var notes = await NotesAsync(client);
            Assert.All(notes, n => Assert.True(n.Pinned));
            Assert.Equal("alpha body", notes.Single(n => n.Id == "a").Body);

            var undo = await BulkAsync(client, "unpin", "a", "b", "c");
            Assert.Equal(3, undo.GetProperty("changed").GetInt32());
            Assert.All(await NotesAsync(client), n => Assert.False(n.Pinned));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkTrash_HidesFromSearch_AndUntrashBringsEverythingBack()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            for (var i = 0; i < 5; i++) await WriteAsync(client, $"n{i}", body: $"zebracorn {i}", title: $"Note {i}");

            var trashed = await BulkAsync(client, "trash", "n0", "n1", "n2");
            Assert.Equal(3, trashed.GetProperty("changed").GetInt32());
            var notes = await NotesAsync(client);
            Assert.Equal(3, notes.Count(n => n.Trashed));

            // Trashing twice is a no-op, not a second retention clock.
            var again = await BulkAsync(client, "trash", "n0");
            Assert.Equal("unchanged", Statuses(again)["n0"]);

            var search = await client.GetFromJsonAsync<JsonElement>("/api/search?q=zebracorn");
            var hits = search.ValueKind == JsonValueKind.Array ? search : search.GetProperty("results");
            Assert.DoesNotContain(hits.EnumerateArray(), h => h.GetProperty("id").GetString() is "n0" or "n1" or "n2");

            var restored = await BulkAsync(client, "untrash", "n0", "n1", "n2");
            Assert.Equal(3, restored.GetProperty("changed").GetInt32());
            Assert.DoesNotContain(await NotesAsync(client), n => n.Trashed);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkArchive_RoundTrips()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            await WriteAsync(client, "a");
            await WriteAsync(client, "b");
            await BulkAsync(client, "archive", "a", "b");
            Assert.All(await NotesAsync(client), n => Assert.True(n.Archived));
            await BulkAsync(client, "unarchive", "a", "b");
            Assert.All(await NotesAsync(client), n => Assert.False(n.Archived));
        }
        finally { Cleanup(factory, dir); }
    }

    [Theory]
    [InlineData("""{"ids":["a"],"action":"explode"}""")]
    [InlineData("""{"ids":["a"]}""")]
    [InlineData("""{"ids":[],"action":"pin"}""")]
    [InlineData("""{"ids":["", "  "],"action":"pin"}""")]
    [InlineData("""{"action":"pin"}""")]
    public async Task BulkAction_RejectsNonsense(string json)
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            var res = await client.PostAsync("/api/notes/bulk",
                new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkAction_CapsTheSelectionSize()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            var ids = Enumerable.Range(0, 1001).Select(i => $"x{i}").ToArray();
            var res = await client.PostAsJsonAsync("/api/notes/bulk", new { ids, action = "pin" });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkAction_CannotReachAnotherUsersNotes()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "mine", body: "private");
            var eve = await MemberAsync(factory, owner, "eve");

            var result = await BulkAsync(eve, "trash", "mine");
            Assert.Equal("notFound", Statuses(result)["mine"]);
            Assert.False(Assert.Single(await NotesAsync(owner)).Trashed);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkPin_OnALockedNote_KeepsItsBody()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", body: "sort code 00-00-00", secure: true);

            await BulkAsync(client, "pin", "s1");
            Assert.Equal("sort code 00-00-00", await SecureBodyAsync(factory, client, "s1"));
        }
        finally { Cleanup(factory, dir); }
    }

    // The card's own pin/archive toggle PUTs the whole note from the list — where
    // a locked note's body is withheld. That save used to erase the note.
    [Fact]
    public async Task ASaveFromALockedClient_NeverErasesTheLockedBody()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", body: "sort code 00-00-00", secure: true);

            var listed = Assert.Single(await NotesAsync(client));
            Assert.Equal(string.Empty, listed.Body); // what the card has in hand
            await WriteAsync(client, "s1", body: listed.Body, pinned: true); // secure omitted, as the card sends

            Assert.True(Assert.Single(await NotesAsync(client)).Pinned);
            Assert.Equal("sort code 00-00-00", await SecureBodyAsync(factory, client, "s1"));
        }
        finally { Cleanup(factory, dir); }
    }

    // The other side of that guard: the editor's autosave of an open locked note
    // sends no unlock token, and its edits must never be swallowed.
    [Fact]
    public async Task AnEditorSaveToALockedNote_StillWritesTheNewText()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            await TestAuth.SetVaultPinAsync(client, Pw);
            await WriteAsync(client, "s1", body: "first draft", secure: true);
            await WriteAsync(client, "s1", body: "second draft", secure: true);
            Assert.Equal("second draft", await SecureBodyAsync(factory, client, "s1"));
        }
        finally { Cleanup(factory, dir); }
    }

    private static async Task<string?> SecureBodyAsync(WebApplicationFactory<Program> factory, HttpClient client, string id)
    {
        var token = factory.Services.GetRequiredService<UnlockTokenStore>().Issue("1");
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/{id}/secure");
        req.Headers.Add("X-Unlock-Token", token);
        var res = await client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("body").GetString();
    }

    [Fact]
    public async Task BulkPin_HandlesALargeSelectionInOneRequest()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await OwnerAsync(factory);
            var ids = Enumerable.Range(0, 150).Select(i => $"n{i}").ToArray();
            foreach (var id in ids) await WriteAsync(client, id);

            var result = await BulkAsync(client, "pin", ids);
            Assert.Equal(150, result.GetProperty("changed").GetInt32());
            Assert.All(await NotesAsync(client), n => Assert.True(n.Pinned));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Bulk share ───────────────────────────────────────────────────────────

    private static async Task<JsonElement> ShareAsync(HttpClient client, string grantee, string access, params string[] noteIds)
    {
        var res = await client.PostAsJsonAsync("/api/shares/bulk", new { noteIds, granteeUsername = grantee, access });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task BulkShare_GivesEachNoteItsOwnVerdict()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await TestAuth.SetVaultPinAsync(owner, Pw);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteAsync(owner, "a", title: "A");
            await WriteAsync(owner, "b", title: "B");
            await WriteAsync(owner, "locked", body: "secret", secure: true);
            await WriteAsync(owner, "binned");
            await BulkAsync(owner, "trash", "binned");

            var first = await ShareAsync(owner, "bea", "view", "a", "locked", "binned", "ghost");
            var s = Statuses(first);
            Assert.Equal("shared", s["a"]);
            Assert.Equal("locked", s["locked"]);
            Assert.Equal("notFound", s["binned"]);
            Assert.Equal("notFound", s["ghost"]);
            Assert.Equal(1, first.GetProperty("shared").GetInt32());

            // Re-sharing reuses the grant; asking for edit upgrades it; a new note is shared.
            var second = await ShareAsync(owner, "bea", "edit", "a", "b");
            var s2 = Statuses(second);
            Assert.Equal("upgraded", s2["a"]);
            Assert.Equal("shared", s2["b"]);

            // Never quietly downgraded.
            var third = await ShareAsync(owner, "bea", "view", "a");
            Assert.Equal("alreadyShared", Statuses(third)["a"]);

            var incoming = await bea.GetFromJsonAsync<List<JsonElement>>("/api/shares/incoming") ?? [];
            Assert.Equal(2, incoming.Count);
            Assert.All(incoming, i => Assert.Equal("edit", i.GetProperty("access").GetString()));
            Assert.DoesNotContain(incoming, i => i.GetProperty("noteId").GetString() == "locked");
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task BulkShare_RefusesBadGrantees_AndOtherPeoplesNotes()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var eve = await MemberAsync(factory, owner, "eve");
            await WriteAsync(owner, "a");

            Assert.Equal(HttpStatusCode.NotFound,
                (await owner.PostAsJsonAsync("/api/shares/bulk", new { noteIds = new[] { "a" }, granteeUsername = "nobody" })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync("/api/shares/bulk", new { noteIds = new[] { "a" }, granteeUsername = "owner" })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync("/api/shares/bulk", new { noteIds = new[] { "a" }, granteeUsername = "  " })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync("/api/shares/bulk", new { noteIds = Array.Empty<string>(), granteeUsername = "eve" })).StatusCode);

            // Eve can't share the owner's note with herself (or anyone) by guessing its id.
            var stolen = await ShareAsync(eve, "owner", "edit", "a");
            Assert.Equal("notFound", Statuses(stolen)["a"]);
            Assert.Equal(0, stolen.GetProperty("shared").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }
}
