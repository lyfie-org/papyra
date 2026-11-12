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

// The daily update check: one plain request to GitHub that carries nothing about the install, when it stays
// silent, what it will believe, and that only admins see the result.
public sealed class UpdateCheckTests
{
    private const string Pw = "hunter2!";

    // A GitHub "latest release" answer.
    private static string Release(string tag, string? url = null, bool draft = false, bool prerelease = false) =>
        JsonSerializer.Serialize(new
        {
            tag_name = tag, name = tag, draft, prerelease,
            html_url = url ?? $"https://github.com/lyfie-org/papyra/releases/tag/{tag}",
            body = "Notes", assets = Array.Empty<object>(),
        });

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
    public void Parse_TakesAReleaseFromGitHub_AndStripsTheV()
    {
        var ok = UpdateChecker.Parse(Release("v1.2.0"))!;
        Assert.Equal(("1.2.0", "https://github.com/lyfie-org/papyra/releases/tag/v1.2.0"), (ok.Version, ok.Url));

        Assert.Equal("1.2.0", UpdateChecker.Parse(Release("1.2.0"))!.Version);        // a tag without the v
    }

    [Theory]
    [InlineData("v1.2.0-rc.1")]
    [InlineData("release-2026")]
    [InlineData("")]
    public void Parse_IgnoresATagThatIsNotAFinalReleaseNumber(string tag) =>
        Assert.Null(UpdateChecker.Parse(Release(tag)));

    [Fact]
    public void Parse_NeverOffersADraftOrAPreRelease()
    {
        Assert.Null(UpdateChecker.Parse(Release("v1.3.0", draft: true)));
        Assert.Null(UpdateChecker.Parse(Release("v1.3.0", prerelease: true)));
        Assert.Null(UpdateChecker.Parse("""{"nothing":true}"""));
        Assert.Null(UpdateChecker.Parse("[]"));
    }

    [Fact]
    public void Parse_ReplacesALinkThatIsNotTheProjectsWithItsReleasesPage()
    {
        var other = UpdateChecker.Parse(Release("v1.2.0", url: "https://evil.example/update"))!;
        Assert.Equal(UpdateChecker.ReleasesPage, other.Url);
        var none = UpdateChecker.Parse("""{"tag_name":"v1.2.0"}""")!;
        Assert.Equal(UpdateChecker.ReleasesPage, none.Url);
    }

    [Theory]
    [InlineData("https://github.com/lyfie-org/papyra", true)]
    [InlineData("https://github.com/lyfie-org/papyra/releases/tag/v1.2.0", true)]
    [InlineData("https://github.com/lyfie-org/papyra-evil/releases", false)]
    [InlineData("https://github.com/lyfie-orgs/papyra", false)]
    [InlineData("https://github.com.evil.example/lyfie-org/papyra", false)]
    [InlineData("https://github.com@evil.example/lyfie-org/papyra", false)]
    [InlineData("https://papyra.app", false)]
    [InlineData("http://github.com/lyfie-org/papyra", false)]
    [InlineData("github.com/lyfie-org/papyra", false)]
    [InlineData("", false)]
    public void IsProjectLink_ComparesTheWholeHostAndPath(string url, bool expected) => Assert.Equal(expected, UpdateChecker.IsProjectLink(url));

    // ── The request ──────────────────────────────────────────────────────────

    private sealed record Seen(Uri Uri, Dictionary<string, string> Headers);

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<Seen> Requests { get; } = [];
        public int Calls => Requests.Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            // Every header the request carries, as a client would put it on the wire.
            var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
            Requests.Add(new Seen(request.RequestUri!, headers));
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

    private static HttpResponseMessage Json(string body, string? etag = null)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        if (etag is not null) response.Headers.TryAddWithoutValidation("ETag", etag);
        return response;
    }

    private static (UpdateChecker Checker, UpdateStatus Status, Handler Handler, string Dir) Make(
        string version, Func<HttpRequestMessage, HttpResponseMessage> answer, bool production = true, bool optedIn = true)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dir }).Build();
        var status = new UpdateStatus(version, production, optedIn);
        var handler = new Handler(answer);
        var checker = new UpdateChecker(status, new Factory(handler), config, new Env(dir), TimeProvider.System, NullLogger<UpdateChecker>.Instance);
        return (checker, status, handler, dir);
    }

    [Fact]
    public async Task ItAsksGitHubForTheLatestRelease_AndSendsNothingAboutTheInstall()
    {
        var (checker, status, handler, dir) = Make("1.0.0", _ => Json(Release("v1.1.0")));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));

            var seen = Assert.Single(handler.Requests);
            Assert.Equal("https://api.github.com/repos/lyfie-org/papyra/releases/latest", seen.Uri.ToString());
            Assert.Equal("", seen.Uri.Query);                                  // no query string: nothing rides along

            // The whole of what the request says, by name. A new header or field fails here on purpose:
            // the check must stay a plain question to GitHub. Do not add to this list.
            Assert.Equal(
                ["Accept", "User-Agent", "X-GitHub-Api-Version"],
                seen.Headers.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            Assert.Equal("Papyra", seen.Headers["User-Agent"]);                // not even the version
            Assert.Equal("application/vnd.github+json", seen.Headers["Accept"]);

            // Nothing about this install anywhere in it.
            var everything = seen.Uri + " " + string.Join(" ", seen.Headers.Select(h => h.Key + h.Value));
            Assert.DoesNotContain("1.0.0", everything.Replace("2022-11-28", ""));
            Assert.DoesNotContain(Environment.MachineName, everything);
            Assert.DoesNotContain(RuntimeArch(), everything.ToLowerInvariant().Replace("x-github-api-version", ""));

            // …and nothing about this install is kept to send: no id file is made.
            Assert.False(File.Exists(Path.Combine(dir, ".papyra", "instance-id")));
            Assert.True(File.Exists(Path.Combine(dir, ".papyra", "update-checked")));   // when it last got an answer, so a restart doesn't ask again
            using var state = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, ".papyra", "update-checked")));
            Assert.Equal(["last"], state.RootElement.EnumerateObject().Select(p => p.Name).ToArray());

            Assert.True(status.Available);
            Assert.Equal("1.1.0", status.Latest!.Version);
            Assert.NotNull(status.CheckedUtc);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    private static string RuntimeArch() => System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant();

    [Fact]
    public async Task TheSecondAskCarriesGitHubsOwnTag_AndAnUnchangedAnswerKeepsTheNotice()
    {
        var (checker, status, handler, dir) = Make("1.0.0", request => request.Headers.Contains("If-None-Match")
            ? new HttpResponseMessage(HttpStatusCode.NotModified)
            : Json(Release("v1.1.0"), etag: "W/\"abc123\""));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.False(handler.Requests[0].Headers.ContainsKey("If-None-Match"));

            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal("W/\"abc123\"", handler.Requests[1].Headers["If-None-Match"]);
            Assert.Equal(
                ["Accept", "If-None-Match", "User-Agent", "X-GitHub-Api-Version"],
                handler.Requests[1].Headers.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            Assert.True(status.Available);                       // "unchanged" keeps what was known
            Assert.Equal("1.1.0", status.Latest!.Version);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task ADevelopmentImage_AsksTheSameQuestion_AndIsNotBehindThePreviousRelease()
    {
        var (checker, status, handler, dir) = Make("1.1.0-dev.abc1234", _ => Json(Release("v1.0.0")));
        try
        {
            Assert.True(status.Enabled);
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.DoesNotContain("abc1234", handler.Requests[0].Uri + string.Join(" ", handler.Requests[0].Headers.Values));
            Assert.False(status.Available);   // a build for the next release is not behind the last one
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task ARepositoryWithNoReleaseYet_IsAnAnswer_NotAnError()
    {
        var (checker, status, _, dir) = Make("1.0.0", _ => new HttpResponseMessage(HttpStatusCode.NotFound));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.False(status.Available);
            Assert.NotNull(status.CheckedUtc);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]        // GitHub's limit for requests without a login
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.BadGateway)]
    public async Task WhenGitHubSaysWaitOrFails_TheNoticeStays_AndItIsTriedAgainLater(HttpStatusCode code)
    {
        var up = true;
        var (checker, status, _, dir) = Make("1.0.0", _ => up ? Json(Release("v1.1.0")) : new HttpResponseMessage(code));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            var rememberedAt = File.ReadAllText(Path.Combine(dir, ".papyra", "update-checked"));
            up = false;

            Assert.False(await checker.CheckNowAsync(CancellationToken.None));       // false = try again later
            Assert.Equal("1.1.0", status.Latest!.Version);                              // what was known is kept
            Assert.Equal(rememberedAt, File.ReadAllText(Path.Combine(dir, ".papyra", "update-checked")));   // a failed check is not remembered as made
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task ADraftOrPreReleaseOnGitHub_NeverBecomesAnUpdateNotice()
    {
        var (checker, status, _, dir) = Make("1.0.0", _ => Json(Release("v1.1.0", prerelease: true)));
        try
        {
            Assert.True(await checker.CheckNowAsync(CancellationToken.None));
            Assert.False(status.Available);
            Assert.Null(status.Latest);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Theory]
    [InlineData("dev", true)]                  // a build with no release number never calls out
    [InlineData("1.0.0", false)]               // nor does a development host (dotnet run, the tests)
    [InlineData("1.0.0-dev.abc1234", false)]
    public async Task ItStaysSilent(string version, bool production)
    {
        var (checker, status, handler, dir) = Make(version, _ => Json(Release("v9.9.9")), production);
        try
        {
            Assert.False(status.Enabled);
            Assert.False(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal(0, handler.Calls);
            Assert.False(Directory.Exists(Path.Combine(dir, ".papyra")));
            Assert.False(status.Available);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task TurnedOff_NothingIsSent()
    {
        // PAPYRA_UPDATE_CHECK_ENABLED=false on a real release: the same silence as a development host.
        var (checker, status, handler, dir) = Make("1.0.0", _ => Json(Release("v9.9.9")), optedIn: false);
        try
        {
            Assert.False(status.Enabled);
            Assert.True(status.TurnedOff);
            Assert.False(await checker.CheckNowAsync(CancellationToken.None));
            Assert.Equal(0, handler.Calls);
            Assert.False(Directory.Exists(Path.Combine(dir, ".papyra")));
            Assert.False(status.Available);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheRandomIdOlderVersionsKept_IsRemovedOnStart_WhetherOrNotTheCheckIsOn(bool optedIn)
    {
        var (checker, _, handler, dir) = Make("1.0.0", _ => Json(Release("v1.0.0")), optedIn: optedIn);
        try
        {
            var file = Path.Combine(dir, ".papyra", "instance-id");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await File.WriteAllTextAsync(file, Guid.NewGuid().ToString());

            await checker.StartAsync(CancellationToken.None);
            // The host starts the work on a pool thread, and stopping before it has begun means it never runs:
            // wait for the clean-up (it is the first thing the checker does), then stop.
            for (var waited = 0; File.Exists(file) && waited < 5000; waited += 20) await Task.Delay(20);
            await checker.StopAsync(CancellationToken.None);

            Assert.False(File.Exists(file));
            Assert.Equal(0, handler.Calls);           // it waits a moment after boot before asking
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void TheEnvironmentVariableFeedsTheOptOut()
    {
        var resolved = EnvAliases.Resolve(new Dictionary<string, string?> { ["PAPYRA_UPDATE_CHECK_ENABLED"] = "false" });
        var config = new ConfigurationBuilder().AddInMemoryCollection(resolved).Build();
        Assert.False(config.GetValue(UpdateStatus.FeatureKey, true));
        Assert.True(new ConfigurationBuilder().Build().GetValue(UpdateStatus.FeatureKey, true));   // on unless said otherwise
    }

    // ── Who sees it ──────────────────────────────────────────────────────────

    [Fact]
    public async Task OnlyAnAdminSeesTheUpdateStatus_AndItListsNothingAboutTheInstall()
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
            Assert.False(status.TryGetProperty("sends", out _));            // there is no install id or fingerprint to show
            Assert.False(status.TryGetProperty("id", out _));

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
