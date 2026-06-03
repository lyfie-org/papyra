using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Papyra.Tests.Integration;

// End-to-end happy path: setup → login → create note → list → update → detail → search endpoint.
// Each test method gets a fresh factory (and temp storage root) via IAsyncLifetime on the class.
public sealed class HappyPathTests : IAsyncLifetime
{
    private PapyraWebFactory _factory = null!;
    private HttpClient _client = null!;

    public async Task InitializeAsync()
    {
        _factory = new PapyraWebFactory();
        await ((IAsyncLifetime)_factory).InitializeAsync();
        _client  = _factory.CreateClient();
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await ((IAsyncLifetime)_factory).DisposeAsync();
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private async Task SetupAdmin(string username = "admin", string password = "AdminPass1!")
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/setup",
            new { username, password, email = $"{username}@papyra.test" });
        resp.EnsureSuccessStatusCode();
    }

    // ── full happy-path scenario ──────────────────────────────────────────────

    [Fact]
    public async Task FullFlow_Setup_Login_CreateNote_List_Update_Detail_Health()
    {
        // 1 — not initialized → /api/auth/me shows uninitialized
        var meAnon = await _client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.False(meAnon.GetProperty("isInitialized").GetBoolean());

        // 2 — setup admin
        await SetupAdmin();

        // 3 — /me now shows authenticated admin
        var me = await _client.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.True(me.GetProperty("isAuthenticated").GetBoolean());
        Assert.Equal("admin", me.GetProperty("username").GetString());
        Assert.Equal("admin", me.GetProperty("role").GetString());

        // 4 — create a note
        var createResp = await _client.PostAsJsonAsync("/notes",
            new { title = "Happy Path Note", tags = new[] { "test", "e2e" } });
        Assert.Equal(HttpStatusCode.Created, createResp.StatusCode);
        var created = (await createResp.Content.ReadFromJsonAsync<JsonElement>());
        var noteId  = created.GetProperty("id").GetString()!;
        Assert.NotEmpty(noteId);

        // 5 — list notes → our note appears (wait for FSW 300ms debounce)
        var list = await PollUntilNoteVisible(_client, noteId);
        Assert.NotNull(list);
        Assert.Contains(list, n => n.GetProperty("id").GetString() == noteId);

        // 6 — update note with content + pin it
        var patchResp = await _client.PutAsJsonAsync($"/notes/{noteId}",
            new { title = "Updated Title", content = "Content for searching.", pinned = true });
        Assert.Equal(HttpStatusCode.NoContent, patchResp.StatusCode);

        // 7 — get note detail — verifies content was written
        var detail = await _client.GetFromJsonAsync<JsonElement>($"/notes/{noteId}");
        Assert.Equal("Updated Title", detail.GetProperty("title").GetString());
        Assert.Equal("Content for searching.", detail.GetProperty("content").GetString());
        Assert.True(detail.GetProperty("pinned").GetBoolean());

        // 8 — archive, then list archived
        var archiveResp = await _client.PatchAsync($"/api/notes/{noteId}/archive", null);
        Assert.Equal(HttpStatusCode.NoContent, archiveResp.StatusCode);

        var active = await _client.GetFromJsonAsync<JsonElement[]>("/notes");
        Assert.DoesNotContain(active!, n => n.GetProperty("id").GetString() == noteId);

        var archived = await _client.GetFromJsonAsync<JsonElement[]>("/notes/archived");
        Assert.Contains(archived!, n => n.GetProperty("id").GetString() == noteId);

        // 9 — restore from archive
        var restoreResp = await _client.PatchAsync($"/api/notes/{noteId}/restore", null);
        Assert.Equal(HttpStatusCode.NoContent, restoreResp.StatusCode);

        var activeAgain = await _client.GetFromJsonAsync<JsonElement[]>("/notes");
        Assert.Contains(activeAgain!, n => n.GetProperty("id").GetString() == noteId);

        // 10 — trash then restore-trash
        var trashResp = await _client.PatchAsync($"/api/notes/{noteId}/trash", null);
        Assert.Equal(HttpStatusCode.NoContent, trashResp.StatusCode);

        var trashed = await _client.GetFromJsonAsync<JsonElement[]>("/notes/trash");
        Assert.Contains(trashed!, n => n.GetProperty("id").GetString() == noteId);

        var restoreTrash = await _client.PatchAsync($"/api/notes/{noteId}/restore-trash", null);
        Assert.Equal(HttpStatusCode.NoContent, restoreTrash.StatusCode);

        // 11 — /health returns structured info (noteCount removed; smtpConfigured returned to auth'd users)
        var health = await _client.GetFromJsonAsync<JsonElement>("/health");
        Assert.Equal("Healthy", health.GetProperty("status").GetString());
        Assert.True(health.TryGetProperty("smtpConfigured", out _));

        // 12 — search endpoint responds (timing-dependent; just assert no 5xx)
        var searchResp = await _client.GetAsync("/search?q=searching");
        Assert.True(searchResp.IsSuccessStatusCode,
            $"Search returned {(int)searchResp.StatusCode}");

        // 13 — delete note permanently
        var deleteResp = await _client.DeleteAsync($"/notes/{noteId}");
        Assert.Equal(HttpStatusCode.NoContent, deleteResp.StatusCode);

        var afterDelete = await _client.GetFromJsonAsync<JsonElement[]>("/notes");
        Assert.DoesNotContain(afterDelete!, n => n.GetProperty("id").GetString() == noteId);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    // Polls GET /notes until the note appears (FSW has 300ms debounce; without
    // waiting the note may not be in the in-memory cache yet).
    private static async Task<JsonElement[]> PollUntilNoteVisible(
        HttpClient client, string noteId, int maxMs = 3000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(maxMs);
        while (DateTime.UtcNow < deadline)
        {
            var list = await client.GetFromJsonAsync<JsonElement[]>("/notes") ?? [];
            if (list.Any(n => n.GetProperty("id").GetString() == noteId)) return list;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Note {noteId} did not appear in GET /notes within {maxMs}ms.");
    }

    [Fact]
    public async Task Login_WrongPassword_Returns401()
    {
        await SetupAdmin();
        // Fresh unauthenticated client
        var anon = _factory.CreateClient();
        var resp = await anon.PostAsJsonAsync("/api/auth/login",
            new { username = "admin", password = "wrong!" });
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task UnauthenticatedRequest_ToProtectedEndpoint_Returns401()
    {
        await SetupAdmin();
        var anon = _factory.CreateClient();
        var resp = await anon.GetAsync("/notes");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
