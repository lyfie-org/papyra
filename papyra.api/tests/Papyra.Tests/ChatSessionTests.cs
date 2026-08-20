using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Conversations with the assistant. No model is reachable in a test, so the
/// answer is always empty — which is the interesting case anyway: the question a
/// person typed has to survive a backend that could not answer it.
/// </summary>
public sealed class ChatSessionTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-chat-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
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
        await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, Pw));
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    /// <summary>Ask a question and read back the NDJSON frames the panel would see.</summary>
    private static async Task<(int SessionId, string Title)> AskAsync(
        HttpClient client, string question, int? sessionId = null)
    {
        var res = await client.PostAsJsonAsync("/api/ai/chat", new AiChatRequest(question, sessionId));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var frames = (await res.Content.ReadAsStringAsync())
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => JsonDocument.Parse(l).RootElement)
            .ToArray();

        var session = frames.Single(f => f.GetProperty("type").GetString() == "session");
        return (session.GetProperty("sessionId").GetInt32(), session.GetProperty("title").GetString()!);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task AskingAQuestionStartsAConversationNamedAfterIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var (id, title) = await AskAsync(owner, "What did I decide about the budget?");

            Assert.True(id > 0);
            Assert.Equal("What did I decide about the budget?", title);

            var list = await owner.GetFromJsonAsync<JsonElement>("/api/ai/sessions");
            var row = list.EnumerateArray().Single();
            Assert.Equal(id, row.GetProperty("id").GetInt32());
            // The question is kept even though no model answered it.
            Assert.Equal(1, row.GetProperty("messageCount").GetInt32());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ALongQuestionBecomesAReadableName()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var (_, title) = await AskAsync(owner,
                "Can you remind me what I wrote about the quarterly marketing budget and the billboard campaign?");

            Assert.True(title.Length <= 61, title);
            Assert.EndsWith("…", title);
            // Cut at a word, not mid-word.
            Assert.DoesNotContain("  ", title);
            Assert.StartsWith("Can you remind me what I wrote about the quarterly", title);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AFollowUpJoinsTheSameConversation()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var (id, _) = await AskAsync(owner, "First question");
            var (again, _) = await AskAsync(owner, "And the second one?", id);

            Assert.Equal(id, again);

            var thread = await owner.GetFromJsonAsync<JsonElement>($"/api/ai/sessions/{id}");
            var messages = thread.GetProperty("messages").EnumerateArray().ToArray();
            Assert.Equal(2, messages.Length);
            Assert.Equal(["First question", "And the second one?"],
                messages.Select(m => m.GetProperty("content").GetString()));
            Assert.All(messages, m => Assert.Equal("user", m.GetProperty("role").GetString()));

            var list = await owner.GetFromJsonAsync<JsonElement>("/api/ai/sessions");
            Assert.Single(list.EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AConversationCanBeRenamedAndDeleted()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var (id, _) = await AskAsync(owner, "Something to rename");

            var renamed = await owner.PatchAsJsonAsync($"/api/ai/sessions/{id}", new ChatSessionRename("Budget chat"));
            Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
            Assert.Equal("Budget chat",
                (await renamed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("title").GetString());

            var blank = await owner.PatchAsJsonAsync($"/api/ai/sessions/{id}", new ChatSessionRename("   "));
            Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);

            Assert.Equal(HttpStatusCode.NoContent,
                (await owner.DeleteAsync($"/api/ai/sessions/{id}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/api/ai/sessions/{id}")).StatusCode);
            Assert.Empty((await owner.GetFromJsonAsync<JsonElement>("/api/ai/sessions")).EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OneAccountsConversationsAreInvisibleToAnother()
    {
        // A transcript of someone's questions is a transcript of their notes, so
        // this is the same boundary as the notes themselves.
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");

            var (ownerSession, _) = await AskAsync(owner, "My private question");

            Assert.Empty((await bea.GetFromJsonAsync<JsonElement>("/api/ai/sessions")).EnumerateArray());
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/ai/sessions/{ownerSession}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await bea.DeleteAsync($"/api/ai/sessions/{ownerSession}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await bea.PatchAsJsonAsync($"/api/ai/sessions/{ownerSession}", new ChatSessionRename("mine now"))).StatusCode);

            // And a question cannot be posted into it either.
            var hijack = await bea.PostAsJsonAsync("/api/ai/chat",
                new AiChatRequest("Adding myself to your thread", ownerSession));
            Assert.Equal(HttpStatusCode.NotFound, hijack.StatusCode);

            // The owner's thread is untouched: still one message, still theirs.
            var thread = await owner.GetFromJsonAsync<JsonElement>($"/api/ai/sessions/{ownerSession}");
            Assert.Single(thread.GetProperty("messages").EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task DeletingAConversationTakesItsMessagesWithIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var (id, _) = await AskAsync(owner, "One");
            await AskAsync(owner, "Two", id);

            await owner.DeleteAsync($"/api/ai/sessions/{id}");

            // Asking again starts a fresh conversation rather than reviving that one.
            var (fresh, _) = await AskAsync(owner, "Three");
            Assert.NotEqual(id, fresh);
            var thread = await owner.GetFromJsonAsync<JsonElement>($"/api/ai/sessions/{fresh}");
            Assert.Single(thread.GetProperty("messages").EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AskingIntoAConversationThatIsGoneSaysSo()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var res = await owner.PostAsJsonAsync("/api/ai/chat", new AiChatRequest("Hello", 9999));
            Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ConversationsNeedASession()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await AskAsync(owner, "Mine");

            var anonymous = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/ai/sessions")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await anonymous.PostAsJsonAsync("/api/ai/chat", new AiChatRequest("Hello"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnEmptyQuestionStartsNothing()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var res = await owner.PostAsJsonAsync("/api/ai/chat", new AiChatRequest("   "));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Empty((await owner.GetFromJsonAsync<JsonElement>("/api/ai/sessions")).EnumerateArray());
        }
        finally { Cleanup(factory, dir); }
    }
}
