using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Repository = LibGit2Sharp.Repository;

namespace Papyra.Tests;

// Locked notes are encrypted at rest: the .md on disk — and every copy of it
// (history, the plain git mirror) — carries neither the title nor the text.
public sealed class LockedNoteEncryptionTests
{
    private const string Pw = "hunter2!";

    // ── The cipher and the file format ──────────────────────────────────────────

    [Fact]
    public async Task LockedNote_IsSealedOnDisk_AndOnlyItsOwnerOpensIt()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-cipher-" + Guid.NewGuid().ToString("N"));
        try
        {
            var storage = new MarkdownStorageService(NewCipher(dir));
            var mine = Path.Combine(dir, "users", "1", "notes", "bank.md");
            await storage.WriteAsync(mine, new Note
            {
                Id = "s1", Title = "Bank details", Tags = ["money"], Secure = true, Body = "sort code 00-00-00",
            });

            var raw = await File.ReadAllTextAsync(mine);
            Assert.DoesNotContain("Bank", raw);
            Assert.DoesNotContain("sort code", raw);
            Assert.DoesNotContain("title:", raw);
            Assert.Contains("secure: true", raw);
            Assert.Contains("money", raw);          // tags still place the note in the grid
            Assert.Contains(LockedNoteCipher.Prefix, raw);

            var back = await storage.ReadAsync(mine);
            Assert.Equal("Bank details", back!.Title);
            Assert.Equal("sort code 00-00-00", back.Body);
            Assert.False(back.NeedsSealing);

            // Same note, same bytes: history de-duplicates and git doesn't churn.
            await storage.WriteAsync(mine, back);
            Assert.Equal(raw, await File.ReadAllTextAsync(mine));

            // Another account's copy of the file opens to nothing — and is carried
            // back out untouched rather than sealed a second time.
            var theirs = Path.Combine(dir, "users", "2", "notes", "bank.md");
            Directory.CreateDirectory(Path.GetDirectoryName(theirs)!);
            File.Copy(mine, theirs);
            var foreign = await storage.ReadAsync(theirs);
            Assert.Equal(string.Empty, foreign!.Title);
            Assert.True(LockedNoteCipher.IsEnvelope(foreign.Body));
            await storage.WriteAsync(theirs, foreign);
            Assert.Equal(raw, await File.ReadAllTextAsync(theirs));

            // A flipped character fails authentication instead of decrypting to garbage.
            var tampered = raw[..^3] + (raw[^3] == 'A' ? 'B' : 'A') + raw[^2..];
            await File.WriteAllTextAsync(mine, tampered);
            Assert.True(LockedNoteCipher.IsEnvelope((await storage.ReadAsync(mine))!.Body));

            // A locked note written readable (by hand, or before this existed) says so.
            await File.WriteAllTextAsync(mine, "---\nid: s1\ntitle: Old\nsecure: true\n---\n\nplain");
            Assert.True((await storage.ReadAsync(mine))!.NeedsSealing);

            // Unlocked notes are untouched.
            var plain = Path.Combine(dir, "users", "1", "notes", "groceries.md");
            await storage.WriteAsync(plain, new Note { Id = "n1", Title = "Groceries", Body = "milk" });
            Assert.Contains("milk", await File.ReadAllTextAsync(plain));
            Assert.Contains("title: Groceries", await File.ReadAllTextAsync(plain));
        }
        finally { ForceDelete(dir); }
    }

    [Fact]
    public void LockedFiles_GetAnonymousNames()
    {
        var locked = new Note { Id = "s1", Title = "Bank details", Secure = true };
        var name = NoteFileNamer.DesiredBaseName(locked)!;
        Assert.True(NoteFileNamer.IsLockedName(name));

        var dir = Path.Combine(Path.GetTempPath(), "papyra-names-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            // Even a name a person chose gives way: it would show the title.
            var chosen = Path.Combine(dir, "My Bank.md");
            File.WriteAllText(chosen, "x");
            var target = NoteFileNamer.TargetPath(chosen, name, locked.Id);
            Assert.True(NoteFileNamer.IsLockedName(Path.GetFileNameWithoutExtension(target)));

            // Once anonymous, it stays put — no rename on every save.
            var anonymous = Path.Combine(dir, name + ".md");
            Assert.Equal(anonymous, NoteFileNamer.TargetPath(anonymous, NoteFileNamer.DesiredBaseName(locked), locked.Id));

            // Unlocked again: back to a readable name.
            locked.Secure = false;
            Assert.EndsWith("bank-details.md", NoteFileNamer.TargetPath(anonymous, NoteFileNamer.DesiredBaseName(locked), locked.Id));
        }
        finally { ForceDelete(dir); }
    }

    // ── Through the app ─────────────────────────────────────────────────────────

    [Fact]
    public async Task LockingANote_SealsItAndItsHistory_AndTheAppStillReadsIt()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAdminAsync(factory);
            var token = factory.Services.GetRequiredService<UnlockTokenStore>().Issue("1");
            var notesDir = Path.Combine(dir, "users", "1", "notes");

            Assert.True((await client.PutAsJsonAsync("/api/notes/p1", Write("Diary entry", "first draft"))).IsSuccessStatusCode);
            Assert.True((await client.PutAsJsonAsync("/api/notes/p1", Write("Diary entry", "second draft"))).IsSuccessStatusCode);
            Assert.True((await client.PutAsJsonAsync("/api/notes/p1", Write("Diary entry", "second draft", secure: true))).IsSuccessStatusCode);

            var file = NoteFiles.Find(notesDir, "p1");
            Assert.True(NoteFileNamer.IsLockedName(Path.GetFileNameWithoutExtension(file)));
            var raw = await File.ReadAllTextAsync(file);
            Assert.DoesNotContain("Diary", raw);
            Assert.DoesNotContain("draft", raw);

            // Every earlier version — including the readable ones from before the lock.
            var history = Directory.EnumerateFiles(Path.Combine(dir, "users", "1", ".papyra", "snapshots", "p1"), "*.md").ToList();
            Assert.NotEmpty(history);
            Assert.All(history, f => Assert.DoesNotContain("draft", File.ReadAllText(f)));
            Assert.All(history, f => Assert.DoesNotContain("Diary", File.ReadAllText(f)));

            // The app sees through it: title in the list, body behind the unlock.
            var listed = Assert.Single(await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? []);
            Assert.Equal("Diary entry", listed.Title);
            Assert.Equal("second draft", (await SecureBodyAsync(client, token, "p1")).Body);
            var hit = Assert.Single((await client.GetFromJsonAsync<JsonElement>("/api/search?q=diary")).EnumerateArray());
            Assert.Equal("Diary entry", hit.GetProperty("title").GetString());
            Assert.Equal(string.Empty, hit.GetProperty("snippet").GetString());

            // History still lists and opens the sealed versions.
            var versions = await client.GetFromJsonAsync<JsonElement>("/api/notes/p1/snapshots");
            Assert.True(versions.GetArrayLength() > 0);

            // A draft kept in History from the banner's Review is sealed too.
            var kept = await client.PostAsJsonAsync("/api/notes/p1/snapshots", new { title = "Diary entry", body = "unsaved draft" });
            Assert.True(kept.IsSuccessStatusCode);
            history = Directory.EnumerateFiles(Path.Combine(dir, "users", "1", ".papyra", "snapshots", "p1"), "*.md").ToList();
            Assert.All(history, f => Assert.DoesNotContain("draft", File.ReadAllText(f)));
            var keptId = (await kept.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
            var keptReq = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/p1/snapshots/{keptId}");
            keptReq.Headers.Add("X-Unlock-Token", token);
            Assert.Equal("unsaved draft", (await (await client.SendAsync(keptReq)).Content.ReadFromJsonAsync<Note>())!.Body.Trim());

            // Editing a locked note (autosave sends no flag) keeps it sealed.
            Assert.True((await client.PutAsJsonAsync("/api/notes/p1", Write("Diary entry", "third draft"))).IsSuccessStatusCode);
            file = NoteFiles.Find(notesDir, "p1");
            Assert.DoesNotContain("third", await File.ReadAllTextAsync(file));
            Assert.Equal("third draft", (await SecureBodyAsync(client, token, "p1")).Body);

            // Taking the lock off writes it readable again, under its title.
            var unlock = new HttpRequestMessage(HttpMethod.Put, "/api/notes/p1") { Content = JsonContent.Create(Write("Diary entry", "third draft", secure: false)) };
            unlock.Headers.Add("X-Unlock-Token", token);
            Assert.True((await client.SendAsync(unlock)).IsSuccessStatusCode);
            file = NoteFiles.Find(notesDir, "p1");
            Assert.Equal("diary-entry.md", Path.GetFileName(file));
            Assert.Contains("third draft", await File.ReadAllTextAsync(file));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Boot_SealsLockedNotesThatWereLeftReadable()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAdminAsync(factory);
            Assert.True((await client.PutAsJsonAsync("/api/notes/s1", Write("Bank", "sort code", secure: true))).IsSuccessStatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
        }

        // What an older Papyra (or a text editor) left behind: a locked note and
        // an archived version of it, both readable, the note named after its title.
        var notesDir = Path.Combine(dir, "users", "1", "notes");
        await File.WriteAllTextAsync(Path.Combine(notesDir, "old-secret.md"),
            "---\nid: legacy\ntitle: Old secret\nsecure: true\n---\n\nthe old text");
        var versionDir = Path.Combine(dir, "users", "1", ".papyra", "snapshots", "legacy");
        Directory.CreateDirectory(versionDir);
        await File.WriteAllTextAsync(Path.Combine(versionDir, $"{DateTime.UtcNow.AddMinutes(-10).Ticks}.md"),
            "---\nid: legacy\ntitle: Old secret\n---\n\nthe older text");

        var (again, _) = NewApp(dir);
        try
        {
            var client = again.CreateClient();
            await client.GetAsync("/health"); // boot: the sweep runs before the first request is served

            Assert.False(File.Exists(Path.Combine(notesDir, "old-secret.md")));
            var file = NoteFiles.Find(notesDir, "legacy");
            Assert.True(NoteFileNamer.IsLockedName(Path.GetFileNameWithoutExtension(file)));
            Assert.DoesNotContain("old text", await File.ReadAllTextAsync(file));
            Assert.DoesNotContain("Old secret", await File.ReadAllTextAsync(file));
            var version = Directory.EnumerateFiles(versionDir, "*.md").Single();
            Assert.DoesNotContain("older text", await File.ReadAllTextAsync(version));

            Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync("admin", Pw)).StatusCode);
            var listed = await client.GetFromJsonAsync<List<Note>>("/api/notes") ?? [];
            Assert.Contains(listed, n => n.Id == "legacy" && n.Title == "Old secret" && n.Secure);
        }
        finally { Cleanup(again, dir); }
    }

    [Fact]
    public async Task Export_CarriesLockedNotesReadable()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAdminAsync(factory);
            var token = factory.Services.GetRequiredService<UnlockTokenStore>().Issue("1");
            Assert.True((await client.PutAsJsonAsync("/api/notes/s1", Write("Bank", "sort code 00-00-00", secure: true))).IsSuccessStatusCode);

            var authorize = new HttpRequestMessage(HttpMethod.Post, "/api/export/authorize")
            {
                Content = JsonContent.Create(new { code = await TestAuth.CodeAsync(client) }),
            };
            authorize.Headers.Add("X-Unlock-Token", token);
            var granted = await client.SendAsync(authorize);
            Assert.Equal(HttpStatusCode.OK, granted.StatusCode);
            var ticket = (await granted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString();

            var res = await client.GetAsync($"/api/export?ticket={ticket}");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            using var zip = new ZipArchive(await res.Content.ReadAsStreamAsync());
            var vault = zip.Entries.Single(e => e.FullName.StartsWith("vault/", StringComparison.Ordinal));
            var text = new StreamReader(vault.Open()).ReadToEnd();
            Assert.Contains("title: Bank", text);
            Assert.Contains("sort code 00-00-00", text);
            Assert.Contains("secure: true", text);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task PlainGitBackup_KeepsLockedNotesSealed_AndRestoresThemWithThePassword()
    {
        var (factory, dir) = NewApp();
        var bare = Path.Combine(Path.GetTempPath(), "papyra-remote-" + Guid.NewGuid().ToString("N"));
        var clone = bare + "-clone";
        try
        {
            Repository.Init(bare, isBare: true);
            var client = await SeedAdminAsync(factory);
            Assert.True((await client.PutAsJsonAsync("/api/notes/s1", Write("Bank", "sort code 00-00-00", secure: true))).IsSuccessStatusCode);
            // Signing in with the password is what seals a copy of the keys under it.
            Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync("admin", Pw)).StatusCode);

            Assert.Equal(HttpStatusCode.NoContent, (await client.PutAsJsonAsync("/api/git", new { remoteUrl = new Uri(bare).AbsoluteUri, branch = "main" })).StatusCode);
            Assert.Equal("pushed", (await (await client.PostAsync("/api/git/sync", null)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

            Repository.Clone(bare, clone, new LibGit2Sharp.CloneOptions { BranchName = "main" });
            var vaultFile = Directory.EnumerateFiles(Path.Combine(clone, "vault"), "*.md").Single();
            Assert.DoesNotContain("sort code", File.ReadAllText(vaultFile));
            Assert.DoesNotContain("Bank", File.ReadAllText(vaultFile));
            Assert.True(File.Exists(Path.Combine(clone, "settings", BackupLayout.VaultKeysFile)));
            Assert.DoesNotContain("sort code", File.ReadAllText(Path.Combine(clone, "settings", BackupLayout.VaultKeysFile)));

            // Opening it takes the password the backup was made with.
            var copy = clone + "-copy";
            CopyTree(clone, copy);
            Assert.Equal("password_required", BackupLayout.OpenSealedVault(copy, null));
            Assert.Equal("password_wrong", BackupLayout.OpenSealedVault(copy, "not it"));
            Assert.Null(BackupLayout.OpenSealedVault(copy, Pw));
            var opened = File.ReadAllText(Directory.EnumerateFiles(Path.Combine(copy, "vault"), "*.md").Single());
            Assert.Contains("sort code 00-00-00", opened);
            Assert.Contains("title: Bank", opened);

            // Restoring the opened tree seals it again, under this account's key.
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
                var admin = await db.Users.FindAsync([1]);
                await scope.ServiceProvider.GetRequiredService<BackupLayout>().ApplyAsync(copy, admin!, db, restoreProfile: false, default);
            }
            var notesDir = Path.Combine(dir, "users", "1", "notes");
            var onDisk = NoteFiles.Find(notesDir, "s1");
            Assert.True(NoteFileNamer.IsLockedName(Path.GetFileNameWithoutExtension(onDisk)));
            Assert.DoesNotContain("sort code", File.ReadAllText(onDisk));
            var back = await factory.Services.GetRequiredService<MarkdownStorageService>().ReadAsync(onDisk);
            Assert.Equal("Bank", back!.Title);
            Assert.Equal("sort code 00-00-00", back.Body);
            ForceDelete(copy);
        }
        finally { Cleanup(factory, dir, bare, clone); }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private static NoteWrite Write(string title, string body, bool? secure = null) =>
        new(title, null, null, false, false, body, Secure: secure);

    private static async Task<Note> SecureBodyAsync(HttpClient client, string token, string id)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/{id}/secure");
        req.Headers.Add("X-Unlock-Token", token);
        var res = await client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<Note>())!;
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(string? existing = null)
    {
        var dir = existing ?? Path.Combine(Path.GetTempPath(), "papyra-locked-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.UseSetting("Papyra:SnapshotMinIntervalSeconds", "0");
        });
        return (factory, dir);
    }

    private static async Task<HttpClient> SeedAdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var res = await client.PostSetupAsync(new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        await TestAuth.SetVaultPinAsync(client, Pw);
        return client;
    }

    private static LockedNoteCipher NewCipher(string dataDir)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dataDir }).Build();
        return new LockedNoteCipher(new EphemeralDataProtectionProvider(), config, new TestEnv(dataDir),
            NullLogger<LockedNoteCipher>.Instance);
    }

    private sealed class TestEnv(string root) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "Papyra.Tests";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static void CopyTree(string from, string to)
    {
        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(from, file);
            if (rel.StartsWith(".git", StringComparison.Ordinal)) continue;
            var target = Path.Combine(to, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, params string[] dirs)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        foreach (var d in dirs) ForceDelete(d);
    }

    private static void ForceDelete(string dir)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal);
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
    }
}
