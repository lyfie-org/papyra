using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class JobRegistryTests
{
    private const string Pw = "hunter2!";

    private static JobRegistry NewRegistry() => new(NullLogger<JobRegistry>.Instance);

    [Fact]
    public async Task ARunRecordsWhatHappened()
    {
        var registry = NewRegistry();
        registry.RegisterPeriodic("sweep", "Sweep", "Sweeps.", TimeSpan.FromHours(1),
            _ => Task.FromResult<string?>("3 things swept"));

        Assert.Null(registry.Snapshot().Single().LastRun);

        var run = await registry.RunAsync("sweep", CancellationToken.None);
        Assert.NotNull(run);
        Assert.True(run!.Ok);
        Assert.Equal("3 things swept", run.Summary);

        var status = registry.Snapshot().Single();
        Assert.False(status.Running);
        Assert.Equal("3 things swept", status.LastRun!.Summary);
    }

    [Fact]
    public async Task AFailedSweepIsRecordedRatherThanThrown()
    {
        // The point of the registry: a job that has been failing for a week should
        // be visible, and a failure must never take the host down with it.
        var registry = NewRegistry();
        registry.RegisterPeriodic("sweep", "Sweep", "Sweeps.", TimeSpan.FromHours(1),
            _ => throw new InvalidOperationException("disk is full"));

        var run = await registry.RunAsync("sweep", CancellationToken.None);
        Assert.False(run!.Ok);
        Assert.Equal("disk is full", run.Error);
        Assert.Null(run.Summary);
        Assert.False(registry.Snapshot().Single().Running);
    }

    [Fact]
    public async Task TwoRunsOfTheSameJobNeverOverlap()
    {
        // A person pressing "Run now" while the timer is mid-sweep must not start
        // a second copy — two Trash purges at once is not worth debugging.
        var registry = NewRegistry();
        var started = 0;
        var overlapped = false;
        var running = false;
        var gate = new TaskCompletionSource();

        registry.RegisterPeriodic("sweep", "Sweep", "Sweeps.", TimeSpan.FromHours(1), async _ =>
        {
            if (running) overlapped = true;
            running = true;
            Interlocked.Increment(ref started);
            await gate.Task;
            running = false;
            return null;
        });

        var first = registry.RunAsync("sweep", CancellationToken.None);
        while (Volatile.Read(ref started) == 0) await Task.Delay(5);

        var second = registry.RunAsync("sweep", CancellationToken.None);
        Assert.False(second.IsCompleted);   // waiting on the first
        Assert.Equal(1, Volatile.Read(ref started));

        gate.SetResult();
        await Task.WhenAll(first, second);
        Assert.False(overlapped);
        Assert.Equal(2, Volatile.Read(ref started));
    }

    [Fact]
    public async Task AnAlwaysOnJobIsListedButCannotBeStarted()
    {
        var registry = NewRegistry();
        registry.RegisterContinuous("watcher", "Watch the folder", "Notices changes on disk.");

        var status = registry.Snapshot().Single();
        Assert.Equal(JobKind.Continuous, status.Kind);
        Assert.Null(status.Interval);
        Assert.True(status.Running);
        Assert.Null(await registry.RunAsync("watcher", CancellationToken.None));
    }

    [Fact]
    public async Task AnUnknownJobIsNotSomethingToRun()
    {
        var registry = NewRegistry();
        Assert.False(registry.Knows("nope"));
        Assert.Null(await registry.RunAsync("nope", CancellationToken.None));
    }

    // ── Over the API ────────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-jobs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task TheJobsListDescribesRealWorkInPlainWords()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));

            var jobs = (await admin.GetFromJsonAsync<JsonElement>("/api/jobs")).EnumerateArray().ToArray();
            Assert.NotEmpty(jobs);

            var byId = jobs.ToDictionary(j => j.GetProperty("id").GetString()!);
            Assert.Contains("trash-purge", byId.Keys);
            Assert.Contains("vault-watcher", byId.Keys);

            var purge = byId["trash-purge"];
            Assert.Equal("Empty the Trash", purge.GetProperty("name").GetString());
            Assert.Equal("periodic", purge.GetProperty("kind").GetString());
            Assert.True(purge.GetProperty("canTrigger").GetBoolean());
            Assert.Equal(6 * 60 * 60, purge.GetProperty("intervalSeconds").GetDouble());

            // Always-on work is listed, but there is nothing to press.
            Assert.False(byId["vault-watcher"].GetProperty("canTrigger").GetBoolean());

            // The whole roster has to read as plain language: no user should meet
            // "Lucene", "daemon" or a class name on this screen.
            foreach (var job in jobs)
            {
                var text = job.GetProperty("name").GetString() + " " + job.GetProperty("description").GetString();
                foreach (var jargon in new[] { "Lucene", "daemon", "BackgroundService", "SQLite", "frontmatter", "cron" })
                    Assert.DoesNotContain(jargon, text, StringComparison.OrdinalIgnoreCase);
            }
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnAdminCanRunAJobAndSeeTheResult()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));

            var res = await admin.PostAsync("/api/jobs/share-cleanup/run", null);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            var body = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(body.GetProperty("ok").GetBoolean());

            // And the run shows up on the list afterwards.
            var jobs = (await admin.GetFromJsonAsync<JsonElement>("/api/jobs")).EnumerateArray()
                .Single(j => j.GetProperty("id").GetString() == "share-cleanup");
            Assert.NotEqual(JsonValueKind.Null, jobs.GetProperty("lastRun").ValueKind);
            Assert.True(jobs.GetProperty("lastRun").GetProperty("ok").GetBoolean());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnAlwaysOnJobRefusesToBeStartedOverTheApi()
    {
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));

            Assert.Equal(HttpStatusCode.BadRequest,
                (await admin.PostAsync("/api/jobs/vault-watcher/run", null)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await admin.PostAsync("/api/jobs/not-a-job/run", null)).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task JobsAreAdminsOnly()
    {
        // These describe the instance, and running one touches everybody's notes.
        var (factory, dir) = NewApp();
        try
        {
            var admin = factory.CreateClient();
            await admin.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
                Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/jobs")).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden,
                (await bea.PostAsync("/api/jobs/trash-purge/run", null)).StatusCode);

            var anonymous = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/jobs")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
