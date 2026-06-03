using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace Papyra.Tests.Integration;

public sealed class NoteAuthzFixture : IAsyncLifetime
{
    private PapyraWebFactory _factory = null!;
    
    public PapyraWebFactory Factory => _factory;
    public HttpClient Alice { get; private set; } = null!;
    public HttpClient Bob { get; private set; } = null!;
    public string NoteId { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        _factory = new PapyraWebFactory();
        await ((IAsyncLifetime)_factory).InitializeAsync();

        // Force background hosted services to boot
        _ = _factory.Server;

        // Alice is the admin — sets up the instance
        Alice = _factory.CreateClient();
        var setupResp = await Alice.PostAsJsonAsync("/api/auth/setup",
            new { username = "alice", password = "AlicePass1!", email = "alice@papyra.test" });
        setupResp.EnsureSuccessStatusCode();

        await Alice.PostAsync("/api/admin/settings/toggle-registration", null);

        Bob = _factory.CreateClient();
        var bobResp = await Bob.PostAsJsonAsync("/api/auth/register",
            new { username = "bob", password = "BobPass1!", email = "bob@papyra.test" });
        bobResp.EnsureSuccessStatusCode();

        var primeResp = await Alice.PostAsJsonAsync("/notes", new { title = "Watcher Prime" });
        primeResp.EnsureSuccessStatusCode();
        var primeId = (await primeResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        
        await PollUntilNoteVisible(Alice, primeId, 15000); 

        var noteResp = await Alice.PostAsJsonAsync("/notes",
            new { title = "Alice's Private Note", tags = new[] { "private" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        NoteId = noteJson.GetProperty("id").GetString()!;

        await PollUntilNoteVisible(Alice, NoteId);

        var putResp = await Alice.PutAsJsonAsync($"/notes/{NoteId}",
            new { content = "Secret content." });
        putResp.EnsureSuccessStatusCode();
    }

    public async Task DisposeAsync()
    {
        Alice.Dispose();
        Bob.Dispose();
        await ((IAsyncLifetime)_factory).DisposeAsync();
    }

    public static async Task PollUntilNoteVisible(HttpClient client, string noteId, int maxMs = 15000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(maxMs);
        while (DateTime.UtcNow < deadline)
        {
            var list = await client.GetFromJsonAsync<JsonElement[]>("/notes");
            if (list?.Any(n => n.GetProperty("id").GetString() == noteId) == true) return;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Note {noteId} did not appear in GET /notes within {maxMs}ms.");
    }

    // 💡 NEW: Waits for async cache revocation to complete
    public static async Task PollUntilForbidden(HttpClient client, string url, int maxMs = 15000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(maxMs);
        while (DateTime.UtcNow < deadline)
        {
            var resp = await client.GetAsync(url);
            if (resp.StatusCode == HttpStatusCode.Forbidden) return;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Endpoint {url} did not return Forbidden within {maxMs}ms.");
    }
}

[Collection("SequentialIntegrationTests")]
public sealed class NoteAuthzTests : IClassFixture<NoteAuthzFixture>
{
    private readonly NoteAuthzFixture _fixture;

    public NoteAuthzTests(NoteAuthzFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Bob_CannotSeeAlicesNote_InList()
    {
        var list = await _fixture.Bob.GetFromJsonAsync<JsonElement[]>("/notes");
        Assert.NotNull(list);
        Assert.DoesNotContain(list, n => n.GetProperty("id").GetString() == _fixture.NoteId);
    }

    [Fact]
    public async Task Bob_CannotGetAlicesNote_ByIdDirectly()
    {
        var resp = await _fixture.Bob.GetAsync($"/notes/{_fixture.NoteId}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Bob_CannotUpdateAlicesNote()
    {
        var resp = await _fixture.Bob.PutAsJsonAsync($"/notes/{_fixture.NoteId}",
            new { title = "Hacked!" });
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Bob_CannotDeleteAlicesNote()
    {
        var resp = await _fixture.Bob.DeleteAsync($"/notes/{_fixture.NoteId}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task ReadShare_BobCanGetNote_ButCannotUpdate()
    {
        var shareResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{_fixture.NoteId}/shares",
            new { grantee = "bob", permission = "read" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        var getResp = await _fixture.Bob.GetAsync($"/notes/{_fixture.NoteId}");
        Assert.Equal(HttpStatusCode.OK, getResp.StatusCode);
        var note = await getResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Alice's Private Note", note.GetProperty("title").GetString());

        var putResp = await _fixture.Bob.PutAsJsonAsync($"/notes/{_fixture.NoteId}",
            new { title = "Attempted override" });
        Assert.Equal(HttpStatusCode.Forbidden, putResp.StatusCode);

        // Cleanup
        var shares = await _fixture.Alice.GetFromJsonAsync<JsonElement[]>($"/api/notes/{_fixture.NoteId}/shares");
        var shareId = shares![0].GetProperty("shareId").GetString()!;
        await _fixture.Alice.DeleteAsync($"/api/notes/{_fixture.NoteId}/shares/{shareId}");
        
        // Block until the cache registers the revocation
        await NoteAuthzFixture.PollUntilForbidden(_fixture.Bob, $"/notes/{_fixture.NoteId}");
    }

    [Fact]
    public async Task WriteShare_BobCanUpdateNote()
    {
        var shareResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{_fixture.NoteId}/shares",
            new { grantee = "bob", permission = "write" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        var putResp = await _fixture.Bob.PutAsJsonAsync($"/notes/{_fixture.NoteId}",
            new { title = "Bob's edit", content = "Bob was here." });
        Assert.Equal(HttpStatusCode.NoContent, putResp.StatusCode);

        var detail = await _fixture.Alice.GetFromJsonAsync<JsonElement>($"/notes/{_fixture.NoteId}");
        Assert.Equal("Bob's edit", detail.GetProperty("title").GetString());

        // Cleanup and restore state
        var shares = await _fixture.Alice.GetFromJsonAsync<JsonElement[]>($"/api/notes/{_fixture.NoteId}/shares");
        var shareId = shares![0].GetProperty("shareId").GetString()!;
        await _fixture.Alice.DeleteAsync($"/api/notes/{_fixture.NoteId}/shares/{shareId}");
        
        await _fixture.Alice.PutAsJsonAsync($"/notes/{_fixture.NoteId}",
            new { title = "Alice's Private Note", content = "Secret content." });

        // Block until the cache registers the revocation
        await NoteAuthzFixture.PollUntilForbidden(_fixture.Bob, $"/notes/{_fixture.NoteId}");
    }

    [Fact]
    public async Task PublicLink_AnyoneCanReadNote_WithoutAuth()
    {
        var linkResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{_fixture.NoteId}/shares/public",
            new { expiresInDays = 7 });
        Assert.Equal(HttpStatusCode.OK, linkResp.StatusCode);
        var linkJson = await linkResp.Content.ReadFromJsonAsync<JsonElement>();
        var token = linkJson.GetProperty("token").GetString()!;

        var anon = _fixture.Factory.CreateClient();
        var resp = await anon.GetAsync($"/api/share/{token}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var note = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_fixture.NoteId, note.GetProperty("id").GetString());

        // Cleanup
        var shares = await _fixture.Alice.GetFromJsonAsync<JsonElement[]>($"/api/notes/{_fixture.NoteId}/shares");
        var shareId = shares![0].GetProperty("shareId").GetString()!;
        await _fixture.Alice.DeleteAsync($"/api/notes/{_fixture.NoteId}/shares/{shareId}");
    }

    [Fact]
    public async Task Alice_CanListUsers_AsAdmin()
    {
        var resp = await _fixture.Alice.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task Bob_CannotAccessAdminEndpoints()
    {
        var resp = await _fixture.Bob.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }
}