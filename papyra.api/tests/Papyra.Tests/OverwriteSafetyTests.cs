using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

// Every path that overwrites a note someone else may not get back has to archive
// the revision it replaces first. The notes PUT and the restore endpoint already
// did; these are the two that did not, and both were found by e2e testing:
//   • conflict "keep right" — the other device's copy replaces the parent
//   • a sharee (or an edit-link visitor) writing into the owner's vault
// The conflict flow additionally must not hard-delete the rejected copy.
public sealed class OverwriteSafetyTests
{
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task<string> SeedAdminAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var doc = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return doc.GetProperty("id").GetInt32().ToString();
    }

    private sealed record ConflictDto(string Id, string ParentId);
    private sealed record ShareDto(int Id);

    private static string SnapshotDir(string dataDir, string uid, string noteId)
        => Path.Combine(dataDir, "users", uid, ".papyra", "snapshots", noteId);

    [Fact]
    public async Task KeepRight_ArchivesTheRevisionItReplaces_AndTrashesTheRejectedCopy()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var uid = await SeedAdminAsync(client);

            await client.PutAsJsonAsync("/api/notes/c1", new NoteWrite(
                Title: "Doc", Tags: null, Color: null, Pinned: false, Archived: false,
                Body: "the revision that must survive as history"));

            // A sync tool drops its own copy beside the note (Syncthing's naming).
            var notesDir = Path.Combine(dir, "users", uid, "notes");
            var copyName = "c1.sync-conflict-20260811-090000-K7XQ2R4.md";
            await File.WriteAllTextAsync(
                Path.Combine(notesDir, copyName),
                "---\nid: c1\ntitle: Doc\n---\n\nthe other device's text\n");

            // The watcher registers it; poll rather than sleep on a fixed delay.
            ConflictDto? conflict = null;
            for (var i = 0; i < 40 && conflict is null; i++)
            {
                var list = await client.GetFromJsonAsync<List<ConflictDto>>("/api/conflicts");
                conflict = list?.FirstOrDefault();
                if (conflict is null) await Task.Delay(100);
            }
            Assert.NotNull(conflict);

            var resolve = await client.PostAsJsonAsync(
                $"/api/conflicts/{conflict!.Id}/resolve", new ResolveConflictRequest("right"));
            Assert.Equal(HttpStatusCode.NoContent, resolve.StatusCode);

            // The copy won the note...
            var live = await File.ReadAllTextAsync(Path.Combine(notesDir, "c1.md"));
            Assert.Contains("the other device's text", live);

            // ...but the revision it replaced is recoverable.
            var snaps = Directory.GetFiles(SnapshotDir(dir, uid, "c1"));
            Assert.NotEmpty(snaps);
            Assert.Contains(
                snaps.Select(File.ReadAllText),
                text => text.Contains("the revision that must survive as history"));

            // ...and the rejected copy was retired to .trash, not hard-deleted.
            Assert.False(File.Exists(Path.Combine(notesDir, copyName)));
            var trash = Directory.GetFiles(Path.Combine(dir, "users", uid, ".trash"));
            Assert.Contains(trash, f => Path.GetFileName(f).EndsWith(copyName, StringComparison.Ordinal));
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task ShareeEdit_ArchivesTheOwnersRevisionBeforeOverwritingIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = factory.CreateClient();
            var ownerUid = await SeedAdminAsync(owner);

            await owner.PutAsJsonAsync("/api/notes/s2", new NoteWrite(
                Title: "Shared doc", Tags: null, Color: null, Pinned: false, Archived: false,
                Body: "the owner's words"));

            var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "guest", Name: "Guest", Email: "g@b.c", Password: "hunter2!", Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

            var shareRes = await owner.PostAsJsonAsync("/api/notes/s2/shares", new ShareWrite(
                Kind: "user", Access: "edit", GranteeUsername: "guest", ExpiresUtc: null, MaxViews: null));
            Assert.Equal(HttpStatusCode.OK, shareRes.StatusCode);
            var share = await shareRes.Content.ReadFromJsonAsync<ShareDto>();

            // A second client so the grantee carries their own session cookie.
            var guest = factory.CreateClient();
            var login = await guest.PostAsJsonAsync("/api/auth/login", new LoginRequest("guest", "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);

            var edit = await guest.PutAsJsonAsync(
                $"/api/shares/incoming/{share!.Id}", new SharedBodyWrite("the sharee's replacement"));
            Assert.Equal(HttpStatusCode.NoContent, edit.StatusCode);

            var live = await File.ReadAllTextAsync(Path.Combine(dir, "users", ownerUid, "notes", "s2.md"));
            Assert.Contains("the sharee's replacement", live);

            // The owner's version is in their own snapshot history, not gone.
            var snaps = Directory.GetFiles(SnapshotDir(dir, ownerUid, "s2"));
            Assert.Contains(snaps.Select(File.ReadAllText), text => text.Contains("the owner's words"));
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }
}
