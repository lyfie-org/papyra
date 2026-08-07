using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// A trashed or deleted note must not remain semantically retrievable — otherwise it
// resurfaces in semantic search AND can be cited by the RAG assistant.
public sealed class EmbeddingLifecycleTests
{
    private const string Uid = "1";

    // ── The retrieval filter (no Ollama needed) ─────────────────────────────────

    [Fact]
    public void LiveNote_IsRetrievable_TrashedAndSecureAndMissingAreNot()
    {
        var state = new VaultState();
        var svc = NewService(state);

        state.Upsert(Uid, "/vault/live.md", new Note { Id = "live", Title = "Live" });
        state.Upsert(Uid, "/vault/gone.md", new Note { Id = "gone", Title = "Trashed", Trashed = true });
        state.Upsert(Uid, "/vault/locked.md", new Note { Id = "locked", Title = "Secure", Secure = true });

        Assert.True(svc.IsRetrievable(Uid, "live"));
        Assert.False(svc.IsRetrievable(Uid, "gone"));    // trashed
        Assert.False(svc.IsRetrievable(Uid, "locked"));  // behind the unlock gate
        Assert.False(svc.IsRetrievable(Uid, "deleted")); // no longer in the vault at all
        Assert.False(svc.IsRetrievable("2", "live"));    // another tenant's note
    }

    // ── The cleanup wiring (no Ollama needed) ───────────────────────────────────

    [Fact]
    public async Task TrashingANote_DropsItsEmbeddings()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);
            await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
                Title: "Budget", Tags: null, Color: null, Pinned: false, Archived: false, Body: "spend figures"));

            // Stand in for the background embedder (which needs a live model).
            SeedEmbeddingOnce(factory, "n1");

            var res = await client.PostAsync("/api/notes/n1/trash", content: null);
            Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

            Assert.Equal(0, CountEmbeddings(factory, "n1")); // vectors pruned on trash
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task DeletingANote_DropsItsEmbeddings()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            await SeedAdminAsync(client);
            await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite(
                Title: "Budget", Tags: null, Color: null, Pinned: false, Archived: false, Body: "spend figures"));

            SeedEmbeddingOnce(factory, "n1");
            var res = await client.DeleteAsync("/api/notes/n1");
            Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

            Assert.Equal(0, CountEmbeddings(factory, "n1"));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private static EmbeddingService NewService(VaultState state) => new(
        new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
        new ConfigurationBuilder().Build(),
        state,
        NullLogger<EmbeddingService>.Instance);

    // The note write kicks off a background re-embed that deletes existing rows for
    // the note before inserting its own, so a naive seed can be wiped from under us.
    // Retry until the row survives — at that point the worker has finished and the
    // test is measuring only what trash/delete does.
    private static void SeedEmbeddingOnce(WebApplicationFactory<Program> factory, string noteId)
    {
        for (var attempt = 0; attempt < 40; attempt++)
        {
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                db.NoteEmbeddings.Add(new NoteEmbedding
                {
                    NoteId = noteId,
                    UserId = Uid,
                    ChunkIndex = 0,
                    Text = "spend figures",
                    Vector = EmbeddingService.ToBytes([0.1f, 0.2f, 0.3f]),
                    CreatedUtc = DateTime.UtcNow,
                });
                db.SaveChanges();
            }

            Thread.Sleep(100);
            if (CountEmbeddings(factory, noteId) > 0) return; // survived → worker done
        }
        Assert.Fail("Could not seed an embedding row that survived the background embedder.");
    }

    private static int CountEmbeddings(WebApplicationFactory<Program> factory, string noteId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return db.NoteEmbeddings.Count(e => e.NoteId == noteId && e.UserId == Uid);
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-emb-" + Guid.NewGuid().ToString("N"));
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
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        Directory.Delete(dir, recursive: true);
    }
}
