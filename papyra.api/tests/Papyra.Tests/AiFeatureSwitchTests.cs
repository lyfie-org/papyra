using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// The assistant is held back for a later release, so a default instance must not
/// serve any of it — and must go on serving everything else.
///
/// 404 rather than 403: the feature isn't forbidden, it isn't there yet.
/// </summary>
public sealed class AiFeatureSwitchTests
{
    private const string Pw = "hunter2!";

    [Theory]
    [InlineData("/api/ai/status")]
    [InlineData("/api/ai/models")]
    [InlineData("/api/ai/config")]
    [InlineData("/api/ai/sessions")]
    [InlineData("/api/search/semantic?q=budget")]
    public async Task AiRoutes_AreNotFound_WhileTheAssistantIsOff(string route)
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync(route)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AskingAQuestion_IsNotFound_WhileTheAssistantIsOff()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var ask = await admin.PostAsJsonAsync("/api/ai/chat", new { question = "what did I write?" });
            Assert.Equal(HttpStatusCode.NotFound, ask.StatusCode);

            var rebuild = await admin.PostAsync("/api/system/rebuild-embeddings", null);
            Assert.Equal(HttpStatusCode.NotFound, rebuild.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    /// <summary>
    /// The half that matters more: switching the assistant off must not take
    /// keyword search — an entirely separate index — off with it.
    /// </summary>
    [Fact]
    public async Task KeywordSearch_StillWorks_WhileTheAssistantIsOff()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var save = await admin.PutAsJsonAsync("/api/notes/quarterly", new NoteWrite(
                Title: "Quarterly", Tags: null, Color: null, Pinned: false, Archived: false,
                Body: "Advertising budget for the quarter."));
            Assert.True(save.IsSuccessStatusCode, $"note save returned {save.StatusCode}");

            var search = await admin.GetAsync("/api/search?q=budget");
            Assert.Equal(HttpStatusCode.OK, search.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    // No Features:Ai setting on purpose — this is a stock instance.
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-aioff-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "admin@example.com", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return client;
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        Directory.Delete(dir, recursive: true);
    }
}
