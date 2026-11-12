using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// The accounts-and-settings backup: what it carries, that a restore brings the
/// accounts back signed-in-able (which needs the key ring that seals their
/// authenticators), and the ways it refuses.
/// </summary>
public sealed class InstanceBackupTests
{
    private const string Pw = "hunter2!";
    private const string Phrase = "correct horse battery staple";

    private static string NewDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static WebApplicationFactory<Program> Boot(string dir) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });

    private static void Stop(WebApplicationFactory<Program> factory)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
    }

    private static void Remove(string dir)
    {
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> AdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var setup = await client.PostSetupAsync(new SetupRequest(Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    private static Task<HttpResponseMessage> Configure(HttpClient admin, bool local = false, int keep = 7, string? passphrase = Phrase) =>
        admin.PutAsJsonAsync("/api/instance-backup", new { passphrase, local, keep, gitRemote = "", gitBranch = "", gitToken = "" });

    private static MultipartFormDataContent RestoreForm(byte[] bundle, string passphrase, string? currentPassword = null)
    {
        var form = new MultipartFormDataContent
        {
            { new StringContent("file"), "kind" },
            { new StringContent(passphrase), "passphrase" },
            { new ByteArrayContent(bundle), "file", "x.papyra-instance" },
        };
        if (currentPassword is not null) form.Add(new StringContent(currentPassword), "currentPassword");
        return form;
    }

    [Fact]
    public async Task Restore_BringsAccountsBack_AndTheKeyRingSealsTheirAuthenticators()
    {
        var source = NewDir();
        var target = NewDir();
        try
        {
            byte[] bundle;
            var a = Boot(source);
            try
            {
                var admin = await AdminAsync(a);
                var made = await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                    Username: "bea", Name: "Bea", Email: "bea@example.com", Password: Pw, Role: "User"));
                Assert.Equal(HttpStatusCode.OK, made.StatusCode);
                Assert.Equal(HttpStatusCode.OK, (await Configure(admin)).StatusCode);

                var download = await admin.GetAsync("/api/instance-backup/download");
                Assert.Equal(HttpStatusCode.OK, download.StatusCode);
                bundle = await download.Content.ReadAsByteArrayAsync();
            }
            finally { Stop(a); }

            // A new install: stage the bundle and queue it, as the first screen does.
            var b = Boot(target);
            try
            {
                await b.CreateClient().GetAsync("/health");
                var service = b.Services.GetRequiredService<InstanceBackupService>();
                await using var stream = new MemoryStream(bundle);
                var summary = await service.StageRestoreAsync(stream, Phrase, CancellationToken.None);
                Assert.Equal(2, summary.Users);
                Assert.True(service.Queue(summary.RestoreId));
            }
            finally { Stop(b); }

            // The next start swaps it in before anything opens the database.
            var c = Boot(target);
            try
            {
                var client = c.CreateClient();
                Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync("admin", Pw)).StatusCode);
                var users = await client.GetFromJsonAsync<JsonElement>("/api/auth/users");
                Assert.Contains(users.EnumerateArray(), u => u.GetProperty("username").GetString() == "bea");
                Assert.Contains(Directory.GetDirectories(Path.Combine(target, ".papyra")), d => Path.GetFileName(d).StartsWith("replaced-by-restore-"));
                Assert.False(Directory.Exists(Path.Combine(target, ".papyra", "pending-restore")));
            }
            finally { Stop(c); }
        }
        finally
        {
            Remove(source);
            Remove(target);
        }
    }

    [Fact]
    public async Task StagingRefusals_NameTheProblem_AndStageNothing()
    {
        var dir = NewDir();
        var factory = Boot(dir);
        try
        {
            var admin = await AdminAsync(factory);
            Assert.Equal(HttpStatusCode.OK, (await Configure(admin)).StatusCode);
            var bundle = await (await admin.GetAsync("/api/instance-backup/download")).Content.ReadAsByteArrayAsync();

            var wrongPassphrase = await admin.PostAsync("/api/instance-backup/restore/stage", RestoreForm(bundle, "not the passphrase", Pw));
            Assert.Equal(HttpStatusCode.BadRequest, wrongPassphrase.StatusCode);
            Assert.Contains("passphrase", await wrongPassphrase.Content.ReadAsStringAsync());

            var wrongPassword = await admin.PostAsync("/api/instance-backup/restore/stage", RestoreForm(bundle, Phrase, "nope"));
            Assert.Equal(HttpStatusCode.Unauthorized, wrongPassword.StatusCode);

            var notABackup = await admin.PostAsync("/api/instance-backup/restore/stage", RestoreForm("garbage"u8.ToArray(), Phrase, Pw));
            Assert.Equal(HttpStatusCode.BadRequest, notABackup.StatusCode);

            var ok = await admin.PostAsync("/api/instance-backup/restore/stage", RestoreForm(bundle, Phrase, Pw));
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            Assert.Equal(1, (await ok.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("users").GetInt32());
        }
        finally
        {
            Stop(factory);
            Remove(dir);
        }
    }

    [Fact]
    public async Task FirstScreenRestore_IsRefusedOnceAnAccountExists()
    {
        var dir = NewDir();
        var factory = Boot(dir);
        try
        {
            var admin = await AdminAsync(factory);
            var res = await admin.PostAsync("/api/auth/setup/restore-instance", RestoreForm([1, 2, 3], Phrase));
            Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        }
        finally
        {
            Stop(factory);
            Remove(dir);
        }
    }

    [Fact]
    public async Task Settings_NeedAPassphrase_AndNeverEchoSecrets()
    {
        var dir = NewDir();
        var factory = Boot(dir);
        try
        {
            var admin = await AdminAsync(factory);

            Assert.Equal(HttpStatusCode.BadRequest, (await Configure(admin, local: true, passphrase: null)).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await Configure(admin, local: true, passphrase: "short")).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/instance-backup/download")).StatusCode);

            var saved = await Configure(admin, local: true);
            Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
            var status = await admin.GetStringAsync("/api/instance-backup");
            Assert.DoesNotContain(Phrase, status);
            Assert.Contains("\"passphraseSet\":true", status);
        }
        finally
        {
            Stop(factory);
            Remove(dir);
        }
    }

    [Fact]
    public async Task OnlyAdministrators_CanUseIt()
    {
        var dir = NewDir();
        var factory = Boot(dir);
        try
        {
            var admin = await AdminAsync(factory);
            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "bea@example.com", Password: Pw, Role: "User"));
            var bea = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await bea.LoginAsync("bea", Pw)).StatusCode);
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/instance-backup")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/instance-backup/download")).StatusCode);
        }
        finally
        {
            Stop(factory);
            Remove(dir);
        }
    }

    [Fact]
    public async Task LocalCopies_AreKeptUpToTheLimit_NewestFirst()
    {
        var dir = NewDir();
        var factory = Boot(dir);
        try
        {
            var admin = await AdminAsync(factory);
            Assert.Equal(HttpStatusCode.OK, (await Configure(admin, local: true, keep: 2)).StatusCode);

            JsonElement status = default;
            for (var i = 0; i < 3; i++)
            {
                var run = await admin.PostAsync("/api/instance-backup/run", null);
                Assert.Equal(HttpStatusCode.OK, run.StatusCode);
                status = await run.Content.ReadFromJsonAsync<JsonElement>();
            }

            Assert.Equal(2, status.GetProperty("copies").GetArrayLength());
            Assert.True(string.IsNullOrEmpty(status.GetProperty("lastError").GetString()));
            Assert.NotNull(status.GetProperty("lastLocalUtc").GetString());
        }
        finally
        {
            Stop(factory);
            Remove(dir);
        }
    }
}
