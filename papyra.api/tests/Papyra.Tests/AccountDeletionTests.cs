using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Data;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Deleting an account: guarded at the door, scheduled a week out, and a real
// purge — files and rows — when the week is up.
public sealed class AccountDeletionTests
{
    private static async Task WithAppAsync(Func<WebApplicationFactory<Program>, HttpClient, string, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-del-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var admin = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await admin.PostSetupAsync(new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"))).StatusCode);
            await body(factory, admin, dir);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public Task Status_ListsWhatStandsInTheWay() => WithAppAsync(async (_, admin, _) =>
    {
        var status = await admin.GetFromJsonAsync<JsonElement>("/api/account/delete");
        var blockers = status.GetProperty("blockers").EnumerateArray().Select(b => b.GetString()!).ToList();
        // Fresh password, no PIN, sole admin: each says so. No mail server is
        // fine — the authenticator from setup confirms it instead.
        Assert.Contains(blockers, b => b.Contains("24 hours"));
        Assert.Contains(blockers, b => b.Contains("vault PIN"));
        Assert.DoesNotContain(blockers, b => b.Contains("email"));
        Assert.Contains(blockers, b => b.Contains("only administrator"));
    });

    [Fact]
    public Task Request_WithoutTheCode_IsRefused() => WithAppAsync(async (_, admin, _) =>
    {
        var res = await admin.PostAsJsonAsync("/api/account/delete",
            new { password = "hunter2!", code = "000000", confirmUsername = "admin" });
        Assert.NotEqual(HttpStatusCode.OK, res.StatusCode);
        Assert.Null((await admin.GetFromJsonAsync<JsonElement>("/api/account/delete")).GetProperty("scheduledUtc").GetString());
    });

    [Fact]
    public Task ScheduledAccount_CanOnlyCancel_AndIsPurgedWhenDue() => WithAppAsync(async (factory, admin, dir) =>
    {
        // A second user with a note.
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: "bea", Name: "Bea", Email: "bea@example.com", Password: "hunter2!", Role: "User"))).StatusCode);
        var bea = factory.CreateClient();
        await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", "hunter2!"));
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, "hunter2!");
        await bea.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Mine", null, null, false, false, "private"));

        int beaId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = db.Users.Single(u => u.Username == "bea");
            beaId = user.Id;
            user.DeletionScheduledUtc = DateTime.UtcNow.AddDays(7);
            await db.SaveChangesAsync();
        }

        // While scheduled: everything but the deletion routes is refused.
        Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/notes")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync("/api/account/delete")).StatusCode);
        Assert.True(Directory.Exists(Path.Combine(dir, "users", beaId.ToString())));

        // The week is up.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Users.Single(u => u.Id == beaId).DeletionScheduledUtc = DateTime.UtcNow.AddMinutes(-1);
            await db.SaveChangesAsync();
        }
        var (purged, _) = await factory.Services.GetRequiredService<AccountDeletion>().SweepAsync(CancellationToken.None);
        Assert.Equal(1, purged);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.False(db.Users.Any(u => u.Id == beaId));
        }
        Assert.False(Directory.Exists(Path.Combine(dir, "users", beaId.ToString())));
        // The admin, who asked for nothing, is untouched.
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/notes")).StatusCode);
    });
}
