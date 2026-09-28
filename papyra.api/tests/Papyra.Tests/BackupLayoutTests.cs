using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Repository = LibGit2Sharp.Repository;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Backups in their published shape — notes/, todos/, vault/, media/{kind}/,
// settings/ — as a git mirror (plain or encrypted) and as the downloadable
// .papyra-vault, and the guided first-run setup that can restore one.
public sealed class BackupLayoutTests
{
    private const string Pw = "hunter2!";

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-backup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
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

    // An admin with a PIN (so notes can be locked), a zone and a theme, holding a
    // note, a to-do, a locked note and a picture.
    private static string LastMedia = string.Empty;

    private static async Task<HttpClient> SeededAdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            "admin", "Admin", "admin@example.com", Pw, Pin: "246810", TimeZone: "Asia/Kolkata", Theme: "dark"));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

        Assert.True((await client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Groceries", null, null, false, false, "milk"))).IsSuccessStatusCode);
        Assert.True((await client.PutAsJsonAsync("/api/notes/t1", new NoteWrite("Chores", null, null, false, false, "- [ ] dishes", Kind: "todo"))).IsSuccessStatusCode);
        Assert.True((await client.PutAsJsonAsync("/api/notes/s1", new NoteWrite("Bank", null, null, false, false, "sort code 00-00-00", Secure: true))).IsSuccessStatusCode);

        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
        using var form = new MultipartFormDataContent { { new ByteArrayContent(png), "file", "pic.png" } };
        var upload = await client.PostAsync("/api/media/upload", form);
        Assert.True(upload.IsSuccessStatusCode);
        LastMedia = (await upload.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("filename").GetString()!;
        return client;
    }

    [Fact]
    public void Codec_RoundTrips_IsDeterministic_AndRefusesTheWrongPassword()
    {
        var plain = Path.Combine(Path.GetTempPath(), "pge-" + Guid.NewGuid().ToString("N"));
        var sealed1 = plain + "-a";
        var sealed2 = plain + "-b";
        var back = plain + "-c";
        try
        {
            Directory.CreateDirectory(Path.Combine(plain, "vault"));
            Directory.CreateDirectory(Path.Combine(plain, "media", "images"));
            File.WriteAllText(Path.Combine(plain, "vault", "secret.md"), "the combination is 1234");
            File.WriteAllBytes(Path.Combine(plain, "media", "images", "a.png"), [1, 2, 3]);

            var key = EncryptedGitCodec.NewDataKey();
            EncryptedGitCodec.EncryptTree(plain, sealed1, key);
            EncryptedGitCodec.EncryptTree(plain, sealed2, key);

            // Folders stay for orientation; names and contents don't leak.
            var files = Directory.EnumerateFiles(sealed1, "*", SearchOption.AllDirectories).ToList();
            Assert.Equal(2, files.Count);
            Assert.Contains(files, f => Path.GetDirectoryName(f)!.EndsWith("vault"));
            Assert.Contains(files, f => Path.GetDirectoryName(f)!.EndsWith(Path.Combine("media", "images")));
            Assert.DoesNotContain(files, f => f.Contains("secret"));
            Assert.All(files, f => Assert.DoesNotContain("combination", File.ReadAllText(f)));

            // Unchanged input → byte-identical output: git sees no change.
            foreach (var f in files)
                Assert.Equal(File.ReadAllBytes(f), File.ReadAllBytes(Path.Combine(sealed2, Path.GetRelativePath(sealed1, f))));

            var header = EncryptedGitCodec.Wrap(key, "pass phrase");
            Assert.Throws<AuthenticationTagMismatchException>(() => EncryptedGitCodec.Unwrap(header, "wrong"));
            var unwrapped = EncryptedGitCodec.Unwrap(header, "pass phrase");
            Assert.Equal(key, unwrapped);

            Assert.Equal(2, EncryptedGitCodec.DecryptTree(sealed1, back, unwrapped));
            Assert.Equal("the combination is 1234", File.ReadAllText(Path.Combine(back, "vault", "secret.md")));
            Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(Path.Combine(back, "media", "images", "a.png")));

            // A flipped byte anywhere fails the whole restore rather than restoring garbage.
            var victim = files[0];
            var bytes = File.ReadAllBytes(victim);
            bytes[^1] ^= 0xFF;
            File.WriteAllBytes(victim, bytes);
            Assert.ThrowsAny<CryptographicException>(() => EncryptedGitCodec.DecryptTree(sealed1, back + "2", unwrapped));
        }
        finally
        {
            foreach (var d in new[] { plain, sealed1, sealed2, back, back + "2" }) ForceDelete(d);
        }
    }

    [Theory]
    [InlineData("photo.JPG", "images")]
    [InlineData("clip.mp4", "videos")]
    [InlineData("memo.m4a", "audio")]
    [InlineData("report.pdf", "documents")]
    [InlineData("thing.bin", "other")]
    public void Media_IsFiledByKind(string name, string folder) => Assert.Equal(folder, BackupLayout.MediaFolder(name));

    [Fact]
    public async Task EncryptedGitBackup_PushesSealedFiles_ThatThePasswordOpens()
    {
        var (factory, dir) = NewApp();
        var bare = Path.Combine(Path.GetTempPath(), "papyra-remote-" + Guid.NewGuid().ToString("N"));
        var clone = bare + "-clone";
        try
        {
            Repository.Init(bare, isBare: true);
            var client = await SeededAdminAsync(factory);

            // Encryption needs the account password — it is what unlocks the backup.
            var noPw = await client.PutAsJsonAsync("/api/git", new { remoteUrl = new Uri(bare).AbsoluteUri, branch = "main", mode = "encrypted" });
            Assert.Equal(HttpStatusCode.Unauthorized, noPw.StatusCode);
            var save = await client.PutAsJsonAsync("/api/git", new { remoteUrl = new Uri(bare).AbsoluteUri, branch = "main", mode = "encrypted", password = Pw });
            Assert.Equal(HttpStatusCode.NoContent, save.StatusCode);
            Assert.Equal("encrypted", (await client.GetFromJsonAsync<JsonElement>("/api/git")).GetProperty("mode").GetString());

            var sync = await (await client.PostAsync("/api/git/sync", null)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("pushed", sync.GetProperty("status").GetString());

            Repository.Clone(bare, clone, new LibGit2Sharp.CloneOptions { BranchName = "main" });
            var manifest = BackupLayout.ReadManifest(clone);
            Assert.NotNull(manifest);
            Assert.True(manifest!.Encrypted);
            foreach (var folder in new[] { "notes", "todos", "vault", "media/images", "settings" })
                Assert.True(Directory.Exists(Path.Combine(clone, folder)), folder);
            foreach (var f in Directory.EnumerateFiles(clone, "*.enc", SearchOption.AllDirectories))
            {
                var text = File.ReadAllText(f);
                Assert.DoesNotContain("sort code", text);
                Assert.DoesNotContain("milk", text);
            }

            var key = EncryptedGitCodec.Unwrap(manifest.Crypto!, Pw);
            var plain = clone + "-plain";
            EncryptedGitCodec.DecryptTree(clone, plain, key);
            var vault = Directory.EnumerateFiles(Path.Combine(plain, "vault")).Single();
            Assert.Contains("sort code 00-00-00", File.ReadAllText(vault));
            Assert.Equal("dark", BackupLayout.ReadAccount(plain)!.Theme);
            ForceDelete(plain);

            // Nothing changed → nothing new to push.
            var again = await (await client.PostAsync("/api/git/sync", null)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("clean", again.GetProperty("status").GetString());

            // A new password re-seals the key; the old one stops working.
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/auth/password", new PasswordRequest(Pw, "n3w-passw0rd!"))).StatusCode);
            await client.PostAsync("/api/git/sync", null);
            ForceDelete(clone);
            Repository.Clone(bare, clone, new LibGit2Sharp.CloneOptions { BranchName = "main" });
            var rewrapped = BackupLayout.ReadManifest(clone)!.Crypto!;
            Assert.ThrowsAny<CryptographicException>(() => EncryptedGitCodec.Unwrap(rewrapped, Pw));
            Assert.Equal(key, EncryptedGitCodec.Unwrap(rewrapped, "n3w-passw0rd!"));
        }
        finally
        {
            Cleanup(factory, dir, bare, clone);
        }
    }

    [Fact]
    public async Task PlainGitBackup_IsNeatlyArranged()
    {
        var (factory, dir) = NewApp();
        var bare = Path.Combine(Path.GetTempPath(), "papyra-remote-" + Guid.NewGuid().ToString("N"));
        var clone = bare + "-clone";
        try
        {
            Repository.Init(bare, isBare: true);
            var client = await SeededAdminAsync(factory);
            Assert.Equal(HttpStatusCode.NoContent, (await client.PutAsJsonAsync("/api/git", new { remoteUrl = new Uri(bare).AbsoluteUri, branch = "main" })).StatusCode);
            var sync = await (await client.PostAsync("/api/git/sync", null)).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("pushed", sync.GetProperty("status").GetString());

            Repository.Clone(bare, clone, new LibGit2Sharp.CloneOptions { BranchName = "main" });
            Assert.Single(Directory.EnumerateFiles(Path.Combine(clone, "notes"), "*.md"));
            Assert.Single(Directory.EnumerateFiles(Path.Combine(clone, "todos"), "*.md"));
            Assert.Single(Directory.EnumerateFiles(Path.Combine(clone, "vault"), "*.md"));
            Assert.Single(Directory.EnumerateFiles(Path.Combine(clone, "media", "images")));
            Assert.True(File.Exists(Path.Combine(clone, "settings", "account.json")));
            Assert.False(BackupLayout.ReadManifest(clone)!.Encrypted);
            // Never the password hash or the PIN.
            var account = File.ReadAllText(Path.Combine(clone, "settings", "account.json"));
            Assert.DoesNotContain("$2", account);
        }
        finally
        {
            Cleanup(factory, dir, bare, clone);
        }
    }

    [Fact]
    public async Task Setup_RestoresAnEncryptedFileBackup_WithItsPreferences()
    {
        var (source, sourceDir) = NewApp();
        var (fresh, freshDir) = NewApp();
        try
        {
            var client = await SeededAdminAsync(source);
            var picture = LastMedia;
            var res = await client.PostAsJsonAsync("/api/backups/generate", new BackupRequest(Pw));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var vaultFile = await res.Content.ReadAsByteArrayAsync();

            var newcomer = fresh.CreateClient();
            var status = await newcomer.GetFromJsonAsync<JsonElement>("/api/auth/setup/status");
            Assert.True(status.GetProperty("needsSetup").GetBoolean());

            MultipartFormDataContent Form(string password) => new()
            {
                { new StringContent("file"), "kind" },
                { new StringContent(password), "password" },
                { new ByteArrayContent(vaultFile), "file", "papyra-backup.papyra-vault" },
            };
            var wrong = await newcomer.PostAsync("/api/auth/setup/restore", Form("nope"));
            Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

            var staged = await (await newcomer.PostAsync("/api/auth/setup/restore", Form(Pw))).Content.ReadFromJsonAsync<JsonElement>();
            var summary = staged.GetProperty("summary");
            Assert.Equal(1, summary.GetProperty("counts").GetProperty("notes").GetInt32());
            Assert.Equal(1, summary.GetProperty("counts").GetProperty("todos").GetInt32());
            Assert.Equal(1, summary.GetProperty("counts").GetProperty("vault").GetInt32());
            Assert.Equal("admin", summary.GetProperty("account").GetProperty("username").GetString());

            // The person sets up their account again — new name, new password —
            // and everything else comes back.
            var setup = await newcomer.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                "restored", null, null, "An0ther-pass!", Pin: "135790", RestoreId: staged.GetProperty("restoreId").GetString()));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            Assert.Equal(3, (await setup.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("restored").GetInt32());

            var me = await newcomer.GetFromJsonAsync<JsonElement>("/api/auth/me");
            Assert.Equal("restored", me.GetProperty("username").GetString());
            Assert.Equal("Asia/Kolkata", me.GetProperty("timeZone").GetString());
            Assert.Equal("dark", me.GetProperty("theme").GetString());

            var notes = await newcomer.GetFromJsonAsync<List<Note>>("/api/notes");
            Assert.Contains(notes!, n => n.Id == "n1");
            Assert.Contains(notes!, n => n.Id == "t1" && n.Kind == "todo");
            Assert.Contains(notes!, n => n.Id == "s1" && n.Secure);
            Assert.Equal(HttpStatusCode.OK, (await newcomer.GetAsync($"/api/media/{picture}")).StatusCode);

            // Setup is over: every setup route is closed.
            Assert.Equal(HttpStatusCode.Conflict, (await newcomer.PostAsync("/api/auth/setup/restore", Form(Pw))).StatusCode);
        }
        finally
        {
            Cleanup(source, sourceDir);
            Cleanup(fresh, freshDir);
        }
    }

    [Fact]
    public async Task Setup_ValidatesItsSteps()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = factory.CreateClient();
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest("bad name", null, null, Pw))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest("ok", null, null, Pw, Pin: "12"))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest("ok", null, null, Pw, TimeZone: "Mars/Base"))).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest("ok", null, null, Pw, RestoreId: "../../etc"))).StatusCode);
            // No mail configured → a code can't be sent, and the address is kept as typed.
            var code = await client.PostAsJsonAsync("/api/auth/setup/email/code", new SetupEmailCodeRequest("me@example.com"));
            Assert.Equal(HttpStatusCode.BadRequest, code.StatusCode);
            Assert.Equal("email_not_configured", (await code.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

            var ok = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest("ok", null, "me@example.com", Pw, Pin: "482915", TimeZone: "Europe/Berlin", Theme: "light"));
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            var vault = await client.GetFromJsonAsync<JsonElement>("/api/auth/vault");
            Assert.True(vault.GetProperty("pinSet").GetBoolean());
        }
        finally
        {
            Cleanup(factory, dir);
        }
    }
}
