using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// THE UPDATE CHECK, written to be read.
//
// Once a day this server asks GitHub for the project's latest release, so an admin can be told when one is
// out. That is the whole of it. The request is a plain
//
//     GET https://api.github.com/repos/lyfie-org/papyra/releases/latest
//
// with a fixed `Accept`, a fixed `User-Agent: Papyra` (GitHub requires one) and, after the first answer, an
// `If-None-Match` carrying GitHub's own ETag. There is no query string, and nothing about this install is in
// it: no id, no version, no processor, no operating system. GitHub sees the address the request comes from,
// as any web server does. Nothing about notes, users or settings is sent. Nobody collects anything: the
// project runs no server for this and keeps no count.
//
// A host with no release version at all (`dotnet run`, the test suite) never calls out.
//
// It is optional: PAPYRA_UPDATE_CHECK_ENABLED=false (Features:UpdateCheck) and the server never asks, and
// admins simply don't hear about updates. Do not add fields to this request.

/// <summary>The newest release, as GitHub describes it.</summary>
public sealed record UpdateInfo(string Version, string Url);

/// <summary>What this server knows about updates; the admin UI reads it, the checker fills it.</summary>
public sealed class UpdateStatus(string current, bool production, bool optedIn = true)
{
    /// <summary>The config key behind <c>PAPYRA_UPDATE_CHECK_ENABLED</c>; on unless set to false.</summary>
    public const string FeatureKey = "Features:UpdateCheck";

    /// <summary>The release this server runs ("dev" for a development build).</summary>
    public string Current { get; } = current;

    /// <summary>
    /// True on a real deployment of a release or a development image that hasn't turned the check off;
    /// false on a development host, a build with no release number, or when <c>PAPYRA_UPDATE_CHECK_ENABLED=false</c>.
    /// </summary>
    public bool Enabled { get; } = production && optedIn && SemVer.IsRelease(current);

    /// <summary>The operator turned the check off.</summary>
    public bool TurnedOff { get; } = !optedIn;

    public UpdateInfo? Latest { get; private set; }
    public DateTime? CheckedUtc { get; private set; }

    public bool Available => Latest is not null && SemVer.IsNewer(Latest.Version, Current);

    internal void Record(UpdateInfo? latest, DateTime nowUtc)
    {
        if (latest is not null) Latest = latest;
        CheckedUtc = nowUtc;
    }
}

/// <summary>Release numbers: <c>1.2.3</c>, or <c>1.2.3-dev.abc</c> for a development build made after that release.</summary>
public static partial class SemVer
{
    [GeneratedRegex(@"^(?<core>\d+\.\d+\.\d+)(?<pre>-[0-9A-Za-z.\-]+)?$")]
    private static partial Regex Pattern();

    private static bool TryParse(string? text, out Version core, out bool prerelease)
    {
        core = new Version();
        prerelease = false;
        var m = Pattern().Match(text ?? string.Empty);
        if (!m.Success) return false;
        prerelease = m.Groups["pre"].Success;
        return Version.TryParse(m.Groups["core"].Value, out core!);
    }

    /// <summary>A release number, final or development ("1.0.0", "1.0.0-dev.abc1234"); not "dev".</summary>
    public static bool IsRelease(string? text) => TryParse(text, out _, out _);

    /// <summary>A final release number (not "dev", not a pre-release).</summary>
    public static bool IsStable(string? text) => TryParse(text, out _, out var pre) && !pre;

    /// <summary>
    /// Is <paramref name="latest"/> (a release) ahead of what is running? Compared by release number only.
    /// A development image is named for the last release plus its commit (1.0.0-dev.abc1234 is built
    /// AFTER 1.0.0, from VERSION still reading 1.0.0), so it is never "behind" the release it is named for.
    /// </summary>
    public static bool IsNewer(string? latest, string? current)
    {
        if (!TryParse(latest, out var l, out var lPre) || lPre) return false;
        if (!TryParse(current, out var c, out _)) return false;
        return l.CompareTo(c) > 0;
    }
}

/// <summary>Asks GitHub for the latest release once a day.</summary>
public sealed class UpdateChecker(
    UpdateStatus status, IHttpClientFactory http, IConfiguration config, IHostEnvironment env,
    TimeProvider clock, ILogger<UpdateChecker> log) : BackgroundService
{
    public const string DefaultUrl = "https://api.github.com/repos/lyfie-org/papyra/releases/latest";

    /// <summary>Where an admin is sent when the answer carries no usable link.</summary>
    public const string ReleasesPage = "https://github.com/lyfie-org/papyra/releases/latest";

    private static readonly TimeSpan AfterBoot = TimeSpan.FromSeconds(45);

    // GitHub's own tag for the answer we hold, so the next ask can be "unchanged?" — kept in memory only.
    private string? _etag;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        // Older versions kept a random id here for counting installs. Nothing uses it any more.
        RemoveOldInstanceId();
        if (!status.Enabled) return;
        try
        {
            // A moment after start, so booting is never slowed by it. Then about once a day.
            var notBefore = clock.GetUtcNow() + AfterBoot;
            var failures = 0;
            while (!stop.IsCancellationRequested)
            {
                var due = UpdateSchedule.Next(clock.GetUtcNow(), ReadLast(), notBefore, () => Random.Shared.Next(0, 3600));
                var wait = due - clock.GetUtcNow();
                await Task.Delay(wait > TimeSpan.Zero ? wait : TimeSpan.Zero, clock, stop);

                // A check that got no answer is tried again in an hour (then two, four, six: see RetryDelay).
                if (await CheckNowAsync(stop))
                {
                    failures = 0;
                    notBefore = due;
                }
                else
                {
                    failures++;
                    notBefore = clock.GetUtcNow() + UpdateSchedule.RetryDelay(failures);
                }
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    // What is remembered across restarts, so a restart doesn't ask again: when the last check got an answer.
    private string StateFile() => Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "update-checked");

    private DateTimeOffset? ReadLast()
    {
        try
        {
            if (!File.Exists(StateFile())) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(StateFile()));
            return doc.RootElement.TryGetProperty("last", out var l) && l.ValueKind == JsonValueKind.String && l.TryGetDateTimeOffset(out var at)
                ? at.ToUniversalTime() : null;
        }
        catch (Exception e) when (e is IOException or JsonException or InvalidOperationException) { return null; }
    }

    private void WriteLast(DateTimeOffset at)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StateFile())!);
        File.WriteAllText(StateFile(), JsonSerializer.Serialize(new { last = at.ToString("O", CultureInfo.InvariantCulture) }));
    }

    private void RemoveOldInstanceId()
    {
        try
        {
            var file = Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "instance-id");
            if (File.Exists(file)) File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* it is only a leftover */ }
    }

    /// <summary>
    /// Ask now. Never throws: a GitHub that can't be reached, or that asks us to wait, just leaves what we knew.
    /// Returns true when GitHub answered (even "no release yet"), false when the check should be tried again later.
    /// </summary>
    public async Task<bool> CheckNowAsync(CancellationToken ct)
    {
        if (!status.Enabled) return false;
        try
        {
            var url = config["Papyra:UpdateCheckUrl"] is { Length: > 0 } custom ? custom : DefaultUrl;
            using var client = http.CreateClient("update-check");
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("Papyra");
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
            if (_etag is not null && status.Latest is not null) request.Headers.TryAddWithoutValidation("If-None-Match", _etag);

            using var response = await client.SendAsync(request, ct);
            var now = clock.GetUtcNow();

            // "Unchanged", or "no release yet": GitHub answered, and there is nothing new to show.
            if (response.StatusCode is HttpStatusCode.NotModified or HttpStatusCode.NotFound)
            {
                if (response.StatusCode == HttpStatusCode.NotFound) _etag = null;
                status.Record(null, now.UtcDateTime);
                WriteLast(now);
                return true;
            }

            // GitHub limits requests that carry no login. That is no error for anyone: ask again later.
            if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            {
                log.LogInformation("GitHub asked for a pause ({Status}); the update check will try again later.", (int)response.StatusCode);
                return false;
            }

            response.EnsureSuccessStatusCode();
            status.Record(Parse(await response.Content.ReadAsStringAsync(ct)), now.UtcDateTime);
            _etag = response.Headers.ETag?.ToString();
            WriteLast(now);
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or IOException)
        {
            log.LogInformation("Update check didn't get an answer ({Reason}).", e.Message);
            return false;
        }
    }

    /// <summary>
    /// The answer, if it is a final release published on GitHub. A draft, a pre-release and a tag that isn't a
    /// release number never become "an update".
    /// </summary>
    internal static UpdateInfo? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (root.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) return null;
        if (root.TryGetProperty("prerelease", out var pre) && pre.ValueKind == JsonValueKind.True) return null;

        var tag = (root.TryGetProperty("tag_name", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null)?.Trim();
        var version = tag is not null && tag.StartsWith('v') ? tag[1..] : tag;
        if (!SemVer.IsStable(version)) return null;

        var url = root.TryGetProperty("html_url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
        // Only ever offer a link to the project's own releases, whatever the answer says.
        if (!IsProjectLink(url)) url = ReleasesPage;
        return new UpdateInfo(version!, url!);
    }

    /// <summary>
    /// An https link to the project's repository. The host is compared whole, so
    /// <c>https://github.com.example.com</c> and <c>https://github.com@example.com</c> are not the project's.
    /// </summary>
    internal static bool IsProjectLink(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || uri.UserInfo.Length > 0) return false;
        const string repo = "/lyfie-org/papyra";
        return uri.Host == "github.com"
            && (uri.AbsolutePath == repo || uri.AbsolutePath.StartsWith(repo + "/", StringComparison.Ordinal));
    }
}
