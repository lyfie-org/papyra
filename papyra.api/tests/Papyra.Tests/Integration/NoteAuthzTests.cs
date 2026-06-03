using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace Papyra.Tests.Integration;

// 💡 Fixture class that manages the single lifecycle of the Test Server and initial shared state
public sealed class NoteAuthzFixture : IAsyncLifetime
{
    private PapyraWebFactory _factory = null!;
    
    // Expose the public Factory property for tests that need to generate anonymous clients
    public PapyraWebFactory Factory => _factory;
    public HttpClient Alice { get; private set; } = null!;
    public HttpClient Bob { get; private set; } = null!;
    public string NoteId { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        _factory = new PapyraWebFactory();
        await ((IAsyncLifetime)_factory).InitializeAsync();

        // Ensure background hosted services are fully armed
        _ = _factory.Server;

        // Alice is the admin — sets up the instance
        Alice = _factory.CreateClient();
        var setupResp = await Alice.PostAsJsonAsync("/api/auth/setup",
            new { username = "alice", password = "AlicePass1!", email = "alice@papyra.test" });
        setupResp.EnsureSuccessStatusCode();

        // Enable self-registration so Bob can register without MustResetPassword
        await Alice.PostAsync("/api/admin/settings/toggle-registration", null);

        // Bob registers as a member
        Bob = _factory.CreateClient();
        var bobResp = await Bob.PostAsJsonAsync("/api/auth/register",
            new { username = "bob", password = "BobPass1!", email = "bob@papyra.test" });
        bobResp.EnsureSuccessStatusCode();

        // This note remains pristine and immutable for strict isolation validation tests
        var noteResp = await Alice.PostAsJsonAsync("/notes",
            new { title = "Alice's Private Note", tags = new[] { "private" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        NoteId = noteJson.GetProperty("id").GetString()!;

        // Wait for the FileSystemWatcher debounce to load the note into the cache
        await PollUntilNoteVisible(Alice, NoteId);

        // Write some content so the note has a body
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
}

// Authorization integration tests: owner isolation, read/write shares, viewer role.
[Collection("SequentialIntegrationTests")]
public sealed class NoteAuthzTests : IClassFixture<NoteAuthzFixture>
{
    private readonly NoteAuthzFixture _fixture;

    public NoteAuthzTests(NoteAuthzFixture fixture)
    {
        _fixture = fixture;
    }

    // ── isolation — non-owner sees nothing (Guaranteed clean state) ──────────

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

    // ── read share ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ReadShare_BobCanGetNote_ButCannotUpdate()
    {
        // Create a transient note dedicated entirely to this test string sequence
        var noteResp = await _fixture.Alice.PostAsJsonAsync("/notes",
            new { title = "Read Share Note", tags = new[] { "share" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        var testNoteId = noteJson.GetProperty("id").GetString()!;
        await NoteAuthzFixture.PollUntilNoteVisible(_fixture.Alice, testNoteId);

        var shareResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{testNoteId}/shares",
            new { grantee = "bob", permission = "read" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        var getResp = await _fixture.Bob.GetAsync($"/notes/{testNoteId}");
        Assert.Equal(HttpStatusCode.OK, getResp.StatusCode);
        var note = await getResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Read Share Note", note.GetProperty("title").GetString());

        var putResp = await _fixture.Bob.PutAsJsonAsync($"/notes/{testNoteId}",
            new { title = "Attempted override" });
        Assert.Equal(HttpStatusCode.Forbidden, putResp.StatusCode);
    }

    // ── write share ───────────────────────────────────────────────────────────

    [Fact]
    public async Task WriteShare_BobCanUpdateNote()
    {
        // Create a transient note dedicated entirely to this test string sequence
        var noteResp = await _fixture.Alice.PostAsJsonAsync("/notes",
            new { title = "Write Share Note", tags = new[] { "share" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        var testNoteId = noteJson.GetProperty("id").GetString()!;
        await NoteAuthzFixture.PollUntilNoteVisible(_fixture.Alice, testNoteId);

        var shareResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{testNoteId}/shares",
            new { grantee = "bob", permission = "write" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        var putResp = await _fixture.Bob.PutAsJsonAsync($"/notes/{testNoteId}",
            new { title = "Bob's edit", content = "Bob was here." });
        Assert.Equal(HttpStatusCode.NoContent, putResp.StatusCode);

        var detail = await _fixture.Alice.GetFromJsonAsync<JsonElement>($"/notes/{testNoteId}");
        Assert.Equal("Bob's edit", detail.GetProperty("title").GetString());
    }

    // ── public link ───────────────────────────────────────────────────────────

    [Fact]
    public async Task PublicLink_AnyoneCanReadNote_WithoutAuth()
    {
        // Create a transient note dedicated entirely to this test string sequence
        var noteResp = await _fixture.Alice.PostAsJsonAsync("/notes",
            new { title = "Public Link Note", tags = new[] { "public" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        var testNoteId = noteJson.GetProperty("id").GetString()!;
        await NoteAuthzFixture.PollUntilNoteVisible(_fixture.Alice, testNoteId);

        var linkResp = await _fixture.Alice.PostAsJsonAsync($"/api/notes/{testNoteId}/shares/public",
            new { expiresInDays = 7 });
        Assert.Equal(HttpStatusCode.OK, linkResp.StatusCode);
        var linkJson = await linkResp.Content.ReadFromJsonAsync<JsonElement>();
        var token = linkJson.GetProperty("token").GetString()!;

        var anon = _fixture.Factory.CreateClient();
        var resp = await anon.GetAsync($"/api/share/{token}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var note = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(testNoteId, note.GetProperty("id").GetString());
    }

    // ── admin access ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Alice_CanListUsers_AsAdmin()
    {
        var resp = await _fixture.Alice.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var users = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(users);
        Assert.Contains(users, u => u.GetProperty("username").GetString() == "alice");
        Assert.Contains(users, u => u.GetProperty("username").GetString() == "bob");
    }

    [Fact]
    public async Task Bob_CannotAccessAdminEndpoints()
    {
        var resp = await _fixture.Bob.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }
}