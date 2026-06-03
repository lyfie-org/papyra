using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace Papyra.Tests.Integration;

// Authorization integration tests: owner isolation, read/write shares, viewer role.
// All tests share one factory instance (separate temp dir from other test classes).
// State is set up once in InitializeAsync: alice (admin), bob (member), a note owned by alice.
[Collection("SequentialIntegrationTests")]
public sealed class NoteAuthzTests : IAsyncLifetime
{
    private PapyraWebFactory _factory = null!;
    private HttpClient _alice  = null!;
    private HttpClient _bob    = null!;
    private string     _noteId = null!;

    // ── shared test setup ─────────────────────────────────────────────────────

    public async Task InitializeAsync()
    {
        _factory = new PapyraWebFactory();
        await ((IAsyncLifetime)_factory).InitializeAsync();

        // 💡 FORCE the TestServer host to boot and start all background hosted 
        // services (like NoteWatcherService) right now, before we hit endpoints.
        _ = _factory.Server; 

        // Alice is the admin — sets up the instance
        _alice = _factory.CreateClient();
        var setupResp = await _alice.PostAsJsonAsync("/api/auth/setup",
            new { username = "alice", password = "AlicePass1!", email = "alice@papyra.test" });
        setupResp.EnsureSuccessStatusCode();

        // Enable self-registration so Bob can register without MustResetPassword
        await _alice.PostAsync("/api/admin/settings/toggle-registration", null);

        // Bob registers as a member
        _bob = _factory.CreateClient();
        var bobResp = await _bob.PostAsJsonAsync("/api/auth/register",
            new { username = "bob", password = "BobPass1!", email = "bob@papyra.test" });
        bobResp.EnsureSuccessStatusCode();

        // Alice creates a note
        var noteResp = await _alice.PostAsJsonAsync("/notes",
            new { title = "Alice's Private Note", tags = new[] { "private" } });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        _noteId = noteJson.GetProperty("id").GetString()!;

        // Wait for the FileSystemWatcher debounce (300ms) to load the note into the cache
        await PollUntilNoteVisible(_alice, _noteId);

        // Write some content so the note has a body
        var putResp = await _alice.PutAsJsonAsync($"/notes/{_noteId}",
            new { content = "Secret content." });
        putResp.EnsureSuccessStatusCode();
    }

    public async Task DisposeAsync()
    {
        _alice.Dispose();
        _bob.Dispose();
        await ((IAsyncLifetime)_factory).DisposeAsync();
    }

    // ── isolation — non-owner sees nothing ───────────────────────────────────

    [Fact]
    public async Task Bob_CannotSeeAlicesNote_InList()
    {
        var list = await _bob.GetFromJsonAsync<JsonElement[]>("/notes");
        Assert.NotNull(list);
        Assert.DoesNotContain(list, n => n.GetProperty("id").GetString() == _noteId);
    }

    [Fact]
    public async Task Bob_CannotGetAlicesNote_ByIdDirectly()
    {
        // The note exists in the cache; endpoint returns 403 when IsPermitted is false.
        var resp = await _bob.GetAsync($"/notes/{_noteId}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Bob_CannotUpdateAlicesNote()
    {
        var resp = await _bob.PutAsJsonAsync($"/notes/{_noteId}",
            new { title = "Hacked!" });
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Bob_CannotDeleteAlicesNote()
    {
        var resp = await _bob.DeleteAsync($"/notes/{_noteId}");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    // ── read share ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ReadShare_BobCanGetNote_ButCannotUpdate()
    {
        // Alice shares the note with Bob (read-only)
        var shareResp = await _alice.PostAsJsonAsync($"/api/notes/{_noteId}/shares",
            new { grantee = "bob", permission = "read" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        // Bob can now GET the note
        var getResp = await _bob.GetAsync($"/notes/{_noteId}");
        Assert.Equal(HttpStatusCode.OK, getResp.StatusCode);
        var note = await getResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Alice's Private Note", note.GetProperty("title").GetString());

        // Bob cannot UPDATE (read-only share)
        var putResp = await _bob.PutAsJsonAsync($"/notes/{_noteId}",
            new { title = "Attempted override" });
        Assert.Equal(HttpStatusCode.Forbidden, putResp.StatusCode);

        // Cleanup — revoke share
        var shares = await _alice.GetFromJsonAsync<JsonElement[]>($"/api/notes/{_noteId}/shares");
        var shareId = shares![0].GetProperty("shareId").GetString()!;
        await _alice.DeleteAsync($"/api/notes/{_noteId}/shares/{shareId}");
    }

    // ── write share ───────────────────────────────────────────────────────────

    [Fact]
    public async Task WriteShare_BobCanUpdateNote()
    {
        // Alice gives Bob write permission
        var shareResp = await _alice.PostAsJsonAsync($"/api/notes/{_noteId}/shares",
            new { grantee = "bob", permission = "write" });
        Assert.Equal(HttpStatusCode.Created, shareResp.StatusCode);

        // Bob can now update the note
        var putResp = await _bob.PutAsJsonAsync($"/notes/{_noteId}",
            new { title = "Bob's edit", content = "Bob was here." });
        Assert.Equal(HttpStatusCode.NoContent, putResp.StatusCode);

        // Alice still sees the updated note
        var detail = await _alice.GetFromJsonAsync<JsonElement>($"/notes/{_noteId}");
        Assert.Equal("Bob's edit", detail.GetProperty("title").GetString());

        // Cleanup — revoke
        var shares = await _alice.GetFromJsonAsync<JsonElement[]>($"/api/notes/{_noteId}/shares");
        var shareId = shares![0].GetProperty("shareId").GetString()!;
        await _alice.DeleteAsync($"/api/notes/{_noteId}/shares/{shareId}");
    }

    // ── public link ───────────────────────────────────────────────────────────

    [Fact]
    public async Task PublicLink_AnyoneCanReadNote_WithoutAuth()
    {
        // Alice creates a public link
        var linkResp = await _alice.PostAsJsonAsync($"/api/notes/{_noteId}/shares/public",
            new { expiresInDays = 7 });
        Assert.Equal(HttpStatusCode.OK, linkResp.StatusCode);
        var linkJson = await linkResp.Content.ReadFromJsonAsync<JsonElement>();
        var token = linkJson.GetProperty("token").GetString()!;

        // Unauthenticated client can read via the public token
        var anon = _factory.CreateClient();
        var resp = await anon.GetAsync($"/api/share/{token}");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var note = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_noteId, note.GetProperty("id").GetString());
    }

    // ── admin access ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Alice_CanListUsers_AsAdmin()
    {
        var resp = await _alice.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var users = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(users);
        Assert.Contains(users, u => u.GetProperty("username").GetString() == "alice");
        Assert.Contains(users, u => u.GetProperty("username").GetString() == "bob");
    }

    [Fact]
    public async Task Bob_CannotAccessAdminEndpoints()
    {
        var resp = await _bob.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    // Polls GET /notes until the note with the given id appears in the list.
    // Required because the FileSystemWatcher has a 300ms debounce; without waiting
    // the note may not be in the in-memory cache when the test proceeds.
    private static async Task PollUntilNoteVisible(
        HttpClient client, string noteId, int maxMs = 15000) // Increased from 3000 to prevent shared runner timing flakiness
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