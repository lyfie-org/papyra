using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Hosting;
using Papyra.Api.Models;

namespace Papyra.Tests;

public sealed class NotesEndpointsTests
{
    // Point the data dir at a throwaway temp folder so the test owns its vault.
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.ConfigureAppConfiguration((_, cfg) => cfg.AddInMemoryCollection(
                new Dictionary<string, string?> { ["Papyra:DataDir"] = dir }));
        });

        return (factory, dir);
    }

    [Fact]
    public async Task Put_WritesMarkdownToDisk_AndGetServesIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();

            var put = await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
                Title: "Hello", Tags: ["a", "b"], Color: "#7aaa8a", Pinned: true, Body: "world"));
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

            var mdPath = Path.Combine(dir, "notes", "n1.md");
            Assert.True(File.Exists(mdPath));
            var raw = await File.ReadAllTextAsync(mdPath);
            Assert.Contains("title: Hello", raw);
            Assert.Contains("world", raw);

            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
            var note = Assert.Single(notes!);
            Assert.Equal("n1", note.Id);
            Assert.Equal("Hello", note.Title);
            Assert.True(note.Pinned);
        }
        finally
        {
            factory.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Delete_RemovesFileAndDropsFromVault()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await client.PutAsJsonAsync("/api/notes/d1", new NoteWrite(
                Title: "Doomed", Tags: null, Color: null, Pinned: false, Body: "bye"));

            var del = await client.DeleteAsync("/api/notes/d1");
            Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

            Assert.False(File.Exists(Path.Combine(dir, "notes", "d1.md")));

            var notes = await client.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Empty(notes!);
        }
        finally
        {
            factory.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task Delete_UnknownId_Returns404()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            var del = await client.DeleteAsync("/api/notes/nope");
            Assert.Equal(HttpStatusCode.NotFound, del.StatusCode);
        }
        finally
        {
            factory.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }
}
