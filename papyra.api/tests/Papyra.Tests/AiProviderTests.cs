using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// The AI provider abstraction: Ollama by default, OpenAI or Anthropic when an
// admin supplies a key.
//
// The behaviour worth protecting is that an *unconfigured* instance stays a
// working instance. No model running must mean a clear explanation, not a 500 and
// not a silently blank answer — the blank answer is the exact bug this work
// exists to fix, so most of these tests run with nothing configured at all.
public sealed class AiProviderTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-ai-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            // Point Ollama at a port nothing is listening on, so the probe takes the
            // "backend unreachable" path deterministically instead of finding a real
            // Ollama on the developer's machine.
            b.UseSetting("Ollama:BaseUrl", "http://127.0.0.1:1");
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

    // ── status ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task WithNoModelRunning_StatusExplainsWhyRatherThanFailing()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var res = await admin.GetAsync("/api/ai/status");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);

            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(body.GetProperty("ready").GetBoolean());
            Assert.False(body.GetProperty("canPull").GetBoolean());
            Assert.False(body.GetProperty("semanticSearchReady").GetBoolean());

            // The point of the whole feature: a sentence the user can act on.
            var reason = body.GetProperty("reason").GetString();
            Assert.False(string.IsNullOrWhiteSpace(reason));
            Assert.Contains("no local model", reason!, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AskingWithNoModel_StreamsTheReasonInsteadOfAnEmptyAnswer()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var res = await admin.PostAsJsonAsync("/api/ai/chat", new { question = "what did I write about?" });
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);

            var text = await res.Content.ReadAsStringAsync();
            var done = text.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => JsonDocument.Parse(l).RootElement)
                .Single(f => f.GetProperty("type").GetString() == "done");

            var error = done.GetProperty("error").GetString();
            Assert.False(string.IsNullOrWhiteSpace(error));
            // Regression guard: the old message was a flat "The local model is
            // unavailable.", which told the user nothing about what to do.
            Assert.Contains("Ollama", error!, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ModelChoices_AreOfferedToSignedInUsers()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var body = await (await admin.GetAsync("/api/ai/models")).Content.ReadFromJsonAsync<JsonElement>();

            // Three tiers, smallest to best, each with a size the user can weigh.
            Assert.Equal(3, body.GetArrayLength());
            foreach (var choice in body.EnumerateArray())
            {
                Assert.False(string.IsNullOrWhiteSpace(choice.GetProperty("model").GetString()));
                Assert.False(string.IsNullOrWhiteSpace(choice.GetProperty("tier").GetString()));
                Assert.False(string.IsNullOrWhiteSpace(choice.GetProperty("size").GetString()));
            }
        }
        finally { Cleanup(factory, dir); }
    }

    // ── configuration ────────────────────────────────────────────────────────

    [Fact]
    public async Task ApiKeys_AreWriteOnly()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            var save = await admin.PutAsJsonAsync("/api/ai/config", new
            {
                chatProvider = "anthropic",
                embedProvider = "ollama",
                anthropicKey = "sk-ant-do-not-echo-me",
                ollamaBaseUrl = "http://127.0.0.1:1",
            });
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);

            var raw = await (await admin.GetAsync("/api/ai/config")).Content.ReadAsStringAsync();
            Assert.DoesNotContain("do-not-echo-me", raw);

            var cfg = JsonDocument.Parse(raw).RootElement;
            Assert.True(cfg.GetProperty("hasAnthropicKey").GetBoolean());
            Assert.False(cfg.GetProperty("hasOpenAiKey").GetBoolean());
            Assert.Equal("anthropic", cfg.GetProperty("chatProvider").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SavingWithABlankKey_KeepsTheStoredOne()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PutAsJsonAsync("/api/ai/config", new
            {
                chatProvider = "openai",
                embedProvider = "ollama",
                openAiKey = "sk-original",
            });

            // The form omits the secret when the user doesn't retype it.
            var again = await admin.PutAsJsonAsync("/api/ai/config", new
            {
                chatProvider = "openai",
                embedProvider = "ollama",
                openAiChatModel = "gpt-4o-mini",
            });
            Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);

            var cfg = await (await admin.GetAsync("/api/ai/config")).Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(cfg.GetProperty("hasOpenAiKey").GetBoolean());
            Assert.Equal("gpt-4o-mini", cfg.GetProperty("openAiChatModel").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SwitchingToAProviderWithNoKey_IsRefused()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            // Otherwise the assistant advertises itself as ready and dead-ends on
            // the first question the user asks.
            var res = await admin.PutAsJsonAsync("/api/ai/config", new
            {
                chatProvider = "openai",
                embedProvider = "ollama",
            });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Anthropic_IsRefusedAsAnEmbeddingProvider()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            // Anthropic publishes no embeddings endpoint; accepting this would
            // quietly stop the semantic index from ever being written.
            var res = await admin.PutAsJsonAsync("/api/ai/config", new
            {
                chatProvider = "anthropic",
                embedProvider = "anthropic",
                anthropicKey = "sk-ant-test",
            });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Contains("embeddings", body.GetProperty("error").GetString()!, StringComparison.OrdinalIgnoreCase);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AiConfigAndPull_AreAdminOnly()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);
            var provision = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@example.com", Password: Pw, Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/ai/config")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bea.PostAsJsonAsync("/api/ai/pull", new { model = "llama3.2:1b" })).StatusCode);

            // ...but she can still see whether the assistant works, and what she
            // could ask an admin to install.
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/ai/status")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/ai/models")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task PullingAnUnofferedModel_IsRefused()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = await AdminAsync(factory);

            // The model name reaches a local daemon that will fetch and run
            // whatever it's told to, so only the curated list is allowed through.
            var res = await admin.PostAsJsonAsync("/api/ai/pull", new { model = "attacker/backdoor:latest" });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    [Fact]
    public void HasModel_TreatsABareNameAsTheLatestTag()
    {
        string[] installed = ["nomic-embed-text:latest", "llama3.1:8b"];

        Assert.True(AiClient.HasModel(installed, "nomic-embed-text"));
        Assert.True(AiClient.HasModel(installed, "nomic-embed-text:latest"));
        Assert.True(AiClient.HasModel(installed, "llama3.1:8b"));

        // A different quantisation is a different download, not a match.
        Assert.False(AiClient.HasModel(installed, "llama3.1:70b"));
        Assert.False(AiClient.HasModel(installed, "mistral-nemo:12b"));
        Assert.False(AiClient.HasModel(installed, ""));
    }

    [Theory]
    [InlineData("openai", AiProviderKind.OpenAi)]
    [InlineData("OpenAI", AiProviderKind.OpenAi)]
    [InlineData("anthropic", AiProviderKind.Anthropic)]
    [InlineData("ollama", AiProviderKind.Ollama)]
    [InlineData("", AiProviderKind.Ollama)]
    [InlineData(null, AiProviderKind.Ollama)]
    [InlineData("nonsense", AiProviderKind.Ollama)]
    public void ParseProvider_FallsBackToLocalOnAnythingUnrecognised(string? raw, AiProviderKind expected) =>
        Assert.Equal(expected, AiClient.ParseProvider(raw, AiProviderKind.Ollama));

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }
}
