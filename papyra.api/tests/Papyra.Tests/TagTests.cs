using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class TagTests
{
    [Fact]
    public void Normalize_TrimsDropsEmptiesAndDeduplicatesCaseInsensitively()
    {
        Assert.Equal(["Work", "home"], TagPolicy.Normalize([" Work ", "", "work", "home", "  "]));
    }

    [Fact]
    public void Validate_CapsCountAndLength_ButNeverBlocksKeepingWhatANoteHad()
    {
        var many = Enumerable.Range(0, TagPolicy.MaxTagsPerNote + 1).Select(i => $"t{i}").ToList();
        Assert.NotNull(TagPolicy.Validate(many, priorCount: 0));
        // A note imported with 30 tags can still be saved (or trimmed to 21).
        Assert.Null(TagPolicy.Validate(many, priorCount: 30));
        Assert.NotNull(TagPolicy.Validate([new string('x', TagPolicy.MaxTagLength + 1)], 0));
        Assert.Null(TagPolicy.Validate(["fine"], 0));
    }

    [Fact]
    public async Task Put_RefusesTooManyTags_AndStoresThemNormalized()
    {
        await WithAppAsync(async client =>
        {
            var tooMany = Enumerable.Range(0, TagPolicy.MaxTagsPerNote + 1).Select(i => $"t{i}").ToList();
            var refused = await PutAsync(client, "n1", tooMany);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

            Assert.Equal(HttpStatusCode.OK, (await PutAsync(client, "n1", [" Work", "work", "home "])).StatusCode);
            var note = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.Equal(["Work", "home"], note.Tags);
        });
    }

    [Fact]
    public async Task DeletingATag_FromNotes_TakesItOffEveryNote()
    {
        await WithAppAsync(async client =>
        {
            await PutAsync(client, "a", ["work", "home"]);
            await PutAsync(client, "b", ["Work"]);
            await PutAsync(client, "c", ["home"]);

            var res = await client.DeleteAsync("/api/categories/work?fromNotes=true");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal(2, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("notesUpdated").GetInt32());

            var notes = (await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []).ToDictionary(n => n.Id);
            Assert.Equal(["home"], notes["a"].Tags);
            Assert.Empty(notes["b"].Tags);
            Assert.Equal(["home"], notes["c"].Tags);

            // And the tag is gone from the tag list (nothing left carries it).
            var tags = await client.GetFromJsonAsync<List<JsonElement>>("/api/categories") ?? [];
            Assert.DoesNotContain(tags, t => string.Equals(t.GetProperty("name").GetString(), "work", StringComparison.OrdinalIgnoreCase));
        });
    }

    private static Task<HttpResponseMessage> PutAsync(HttpClient client, string id, List<string> tags) =>
        client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            Title: id, Tags: tags, Color: null, Pinned: false, Archived: false, Body: "x"));

    private static async Task WithAppAsync(Func<HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-tags-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var client = factory.CreateClient();
            var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: "hunter2!"));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            await body(client);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }
}
