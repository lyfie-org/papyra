using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// The daily update check: what it sends (a random id and a version — nothing else), when it stays
// silent, what it will believe, and that only admins see the result.
public sealed class UpdateCheckTests
{
    private const string Pw = "hunter2!";

    // ── Versions ─────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("1.0.1", "1.0.0", true)]
    [InlineData("1.1.0", "1.0.9", true)]
    [InlineData("2.0.0", "1.9.9", true)]
    [InlineData("1.0.0", "1.0.0", false)]
    [InlineData("1.0.0", "1.0.1", false)]
    [InlineData("1.0.0", "1.0.0-dev.abc1234", false)]  // a dev image is built after the release it is named for
    [InlineData("1.1.0", "1.0.0-dev.abc1234", true)]   // …but a newer release does outrun it
    [InlineData("1.0.0", "1.1.0-dev.abc1234", false)]  // a build for the next release is not
    [InlineData("1.0.1-rc.1", "1.0.0", false)]         // a pre-release is never offered
    [InlineData("nonsense", "1.0.0", false)]
    [InlineData("1.0.1", "dev", false)]                // nothing to compare against
    public void IsNewer_ComparesReleases(string latest, string current, bool expected) =>
        Assert.Equal(expected, SemVer.IsNewer(latest, current));

    [Theory]
    [InlineData("1.0.0", true)]
    [InlineData("1.0.0-dev.abc", false)]
    [InlineData("dev", false)]
    [InlineData("", false)]
    public void IsStable_OnlyForARealRelease(string version, bool expected) => Assert.Equal(expected, SemVer.IsStable(version));

    // ── The answer ───────────────────────────────────────────────────────────

    [Fact]
    public void Parse_TakesAReleaseAndOnlyLinksToTheProject()
    {
        var ok = UpdateChecker.Parse("""{"version":"1.2.0","url":"https://github.com/lyfie-org/papyra/releases/tag/v1.2.0"}""")!;
        Assert.Equal(("1.2.0", "https://github.com/lyfie-org/papyra/releases/tag/v1.2.0"), (ok.Version, ok.Url));

        var elsewhere = UpdateChecker.Parse("""{"version":"1.2.0","url":"https://evil.example/update"}""")!;
        Assert.Equal("https://github.com/lyfie-org/papyra/releases/latest", elsewhere.Url);

        Assert.Null(UpdateChecker.Parse("""{"version":"1.2.0-rc.1","url":"https://papyra.app"}"""));
        Assert.Null(UpdateChecker.Parse("""{"nothing":true}"""));
    }

    // ── The request ──────────────────────────────────────────────────────────

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<Uri> Seen { get; } = [];
        public int Calls => Seen.Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add(request.RequestUri!);
            return Task.FromResult(answer(request));
        }
    }

    private sealed class Factory(Handler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class Env(string root) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "Papyra";
        public string ContentRootPath { get; set; } = root;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static (UpdateChecker Checker, UpdateStatus Status, Handler Handler, string Dir) Make(
        string version, Func<HttpRequestMessage, HttpResponseMessage> answer, bool production = true)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dir }).Build();
        var status = new UpdateStatus(version, production);
        var handler = new Handler(answer);
        var checker = new UpdateChecker(status, new Factory(handler), config, new Env(dir), TimeProvider.System, NullLogger<UpdateChecker>.Instance);
        return (checker, status, handler, dir);
    }

    [Fact]
    public async Task ItSendsARandomIdAndTheVersion_AndNothingElse()
    {
        var (checker, status, handler, dir) = Make("1.0.0", _ => Json("""{"version":"1.1.0","url":"https://papyra.app/docs"}"""));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            await checker.CheckNowAsync(CancellationToken.None);

            var query = System.Web.HttpUtility.ParseQueryString(handler.Seen[0].Query);
            Assert.Equal("arch,id,os,v", string.Join(",", query.AllKeys.OrderBy(k => k)));   // four facts, by name
            Assert.Contains(query["arch"], new[] { "x64", "arm64", "arm", "other" });
            Assert.Contains(query["os"], new[] { "linux", "windows", "macos", "other" });
            Assert.Equal("1.0.0", query["v"]);
            Assert.True(Guid.TryParse(query["id"], out _));
            Assert.Equal("papyra.app", handler.Seen[0].Host.Replace("versions.", ""));

            // The same install is the same id again, and it is kept where an admin can see it.
            Assert.Equal(query["id"], System.Web.HttpUtility.ParseQueryString(handler.Seen[1].Query)["id"]);
            Assert.Equal(query["id"], File.ReadAllText(Path.Combine(dir, ".papyra", "instance-id")).Trim());
            Assert.Equal(query["id"], status.InstanceId);
            Assert.True(File.Exists(Path.Combine(dir, ".papyra", "update-checked")));   // remembered, so a restart doesn't ask again

            Assert.True(status.Available);
            Assert.Equal("1.1.0", status.Latest!.Version);
            Assert.NotNull(status.CheckedUtc);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task ADevelopmentImageReportsItsDevVersion()
    {
        var (checker, status, handler, dir) = Make("1.1.0-dev.abc1234", _ => Json("""{"version":"1.0.0","url":"https://papyra.app"}"""));
        try
        {
            Assert.True(status.Enabled);
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal("1.1.0-dev.abc1234", System.Web.HttpUtility.ParseQueryString(handler.Seen[0].Query)["v"]);
            Assert.False(status.Available);   // a build for the next release is not behind the last one
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task ARetryThatGetsThrough_MovesTheInstallsTimeOfDayToThen()
    {
        var up = false;
        var (checker, status, _, dir) = Make("1.0.0", _ => up ? Json("""{"version":"1.0.0","url":"https://papyra.app"}""") : new HttpResponseMessage(HttpStatusCode.BadGateway));
        try
        {
            var file = Path.Combine(dir, ".papyra", "update-checked");
            Assert.False(await checker.CheckNowAsync(CancellationToken.None));
            Assert.False(File.Exists(file));                 // nothing is remembered about a check that failed

            up = true;
            var before = DateTimeOffset.UtcNow;
            Assert.True(await checker.CheckNowAsync(CancellationToken.None, adoptTimeOfDay: true));
            using var state = JsonDocument.Parse(File.ReadAllText(file));
            var slot = state.RootElement.GetProperty("slot").GetInt32();
            // The time of day of the check that worked (UTC), to the second.
            Assert.InRange(Math.Abs(slot - (int)before.UtcDateTime.TimeOfDay.TotalSeconds), 0, 5);

            // An ordinary check afterwards leaves the adopted time alone.
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            using var again = JsonDocument.Parse(File.ReadAllText(file));
            Assert.Equal(slot, again.RootElement.GetProperty("slot").GetInt32());
            Assert.NotNull(status.CheckedUtc);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Theory]
    [InlineData("dev", true)]                  // a build with no release number never calls out
    [InlineData("1.0.0", false)]               // nor does a development host (dotnet run, the tests)
    [InlineData("1.0.0-dev.abc1234", false)]
    public async Task ItStaysSilent(string version, bool production)
    {
        var (checker, status, handler, dir) = Make(version, _ => Json("""{"version":"9.9.9"}"""), production);
        try
        {
            Assert.False(status.Enabled);
            Assert.False(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal(0, handler.Calls);
            Assert.False(Directory.Exists(Path.Combine(dir, ".papyra")));   // not even an id is made
            Assert.False(status.Available);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task AnUnreachableServerLeavesWhatWasKnown_AndNeverThrows()
    {
        var up = true;
        var (checker, status, _, dir) = Make("1.0.0", _ => up ? Json("""{"version":"1.1.0"}""") : new HttpResponseMessage(HttpStatusCode.BadGateway));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            up = false;
            Assert.False(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal("1.1.0", status.Latest!.Version);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ── Who sees it ──────────────────────────────────────────────────────────

    [Fact]
    public async Task OnlyAnAdminSeesTheUpdateStatus()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var admin = factory.CreateClient();
            await admin.PostSetupAsync(new SetupRequest(Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
            await admin.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));

            var status = await admin.GetFromJsonAsync<JsonElement>("/api/admin/update");
            Assert.False(status.GetProperty("enabled").GetBoolean());       // a development host never calls out
            Assert.False(status.GetProperty("available").GetBoolean());
            Assert.Equal(status.GetProperty("current").GetString(), status.GetProperty("sends").GetProperty("version").GetString());

            var bea = factory.CreateClient();
            await bea.LoginAsync("bea", Pw);
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);
            Assert.Equal(HttpStatusCode.Forbidden, (await bea.GetAsync("/api/admin/update")).StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }
}
