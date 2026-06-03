using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Papyra.Tests.Integration;

// Tests for the GET /api/admin/backup endpoint.
public sealed class BackupTests : IAsyncLifetime
{
    private PapyraWebFactory _factory = null!;
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _factory = new PapyraWebFactory();
        await ((IAsyncLifetime)_factory).InitializeAsync();

        _admin = _factory.CreateClient();
        var resp = await _admin.PostAsJsonAsync("/api/auth/setup",
            new { username = "admin", password = "AdminPass1!" });
        resp.EnsureSuccessStatusCode();
    }

    public async Task DisposeAsync()
    {
        _admin.Dispose();
        await ((IAsyncLifetime)_factory).DisposeAsync();
    }

    [Fact]
    public async Task Backup_ReturnsZip_WithNoteAndSystemFiles()
    {
        // Create a note so we have something to back up
        var noteResp = await _admin.PostAsJsonAsync("/notes",
            new { title = "Backup Test Note" });
        noteResp.EnsureSuccessStatusCode();
        var noteJson = await noteResp.Content.ReadFromJsonAsync<JsonElement>();
        var noteId = noteJson.GetProperty("id").GetString()!;

        // Wait for the FileSystemWatcher to load the note into the cache (300ms debounce)
        await PollUntilNoteVisible(noteId);

        await _admin.PutAsJsonAsync($"/notes/{noteId}",
            new { content = "Content in backup." });

        // Request backup
        var backupResp = await _admin.GetAsync("/api/admin/backup");
        Assert.Equal(HttpStatusCode.OK, backupResp.StatusCode);
        Assert.Equal("application/zip", backupResp.Content.Headers.ContentType?.MediaType);

        // Content-Disposition should include a filename
        var disposition = backupResp.Content.Headers.ContentDisposition?.FileNameStar
            ?? backupResp.Content.Headers.ContentDisposition?.FileName;
        Assert.NotNull(disposition);
        Assert.Contains("papyra-backup", disposition, StringComparison.OrdinalIgnoreCase);

        // Parse the ZIP and verify expected entries
        var zipBytes = await backupResp.Content.ReadAsByteArrayAsync();
        Assert.NotEmpty(zipBytes);

        using var ms      = new MemoryStream(zipBytes);
        using var archive = new ZipArchive(ms, ZipArchiveMode.Read);

        var entryNames = archive.Entries.Select(e => e.FullName).ToList();

        // Note's markdown file should be in the backup
        Assert.Contains(entryNames, name => name.Contains("note.md"));

        // .system directory should be included (settings, users)
        Assert.Contains(entryNames, name => name.StartsWith(".system/", StringComparison.Ordinal));

        // Lucene index must NOT be included (disposable cache)
        Assert.DoesNotContain(entryNames, name =>
            name.StartsWith("index/", StringComparison.OrdinalIgnoreCase));
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private async Task PollUntilNoteVisible(string noteId, int maxMs = 3000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(maxMs);
        while (DateTime.UtcNow < deadline)
        {
            var list = await _admin.GetFromJsonAsync<JsonElement[]>("/notes") ?? [];
            if (list.Any(n => n.GetProperty("id").GetString() == noteId)) return;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Note {noteId} did not appear in GET /notes within {maxMs}ms.");
    }

    [Fact]
    public async Task Backup_NonAdmin_Returns403()
    {
        // Enable registration so we can create a member account
        await _admin.PostAsync("/api/admin/settings/toggle-registration", null);

        var member = _factory.CreateClient();
        await member.PostAsJsonAsync("/api/auth/register",
            new { username = "member", password = "MemberPass1!" });

        var resp = await member.GetAsync("/api/admin/backup");
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Backup_Unauthenticated_Returns401()
    {
        var anon = _factory.CreateClient();
        var resp = await anon.GetAsync("/api/admin/backup");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
