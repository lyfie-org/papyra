using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

// THE UPDATE CHECK — the only thing Papyra ever sends to anyone, written to be read.
//
// Once a day (at a time of day of its own, never 02:30–03:30 UTC: see UpdateSchedule.cs) this server asks versions.papyra.app for the latest release, so an admin
// can be told when one is out. The request carries exactly four facts:
//   • id — a random UUID made on first use and kept in `.papyra/instance-id`. It is not
//          derived from anything (not your hostname, address, accounts or notes), so all
//          it can do is say "the same install again". That is how the project counts
//          installs without knowing who or where they are.
//   • v  — the version number this server is running, "1.0.0" or, for a development build,
//          "1.0.0-dev.abc1234".
//   • arch — the processor family it runs on: x64, arm64 or arm.
//   • os — the operating system family: linux, windows or macos.
// The other end reads the country from the connection and never stores the IP address.
// Nothing about notes, users or settings is sent. A host with no release version at all (`dotnet run`,
// the test suite) never calls out, so developing Papyra doesn't count as installs. Why it exists: so admins hear about updates, and so the person building Papyra can see that it
// is being used. What the other end does with it: papyra.versions/README.md.
//
// It is optional: PAPYRA_UPDATE_CHECK_ENABLED=false (Features:UpdateCheck) and the server never asks, never makes
// an id, and admins simply don't hear about updates.

/// <summary>The newest release, as versions.papyra.app answers it.</summary>
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

    /// <summary>The random id sent with the check, once one exists (shown to admins, so nothing is hidden).</summary>
    public string? InstanceId { get; internal set; }

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

/// <summary>Asks for the latest release once a day.</summary>
public sealed class UpdateChecker(
    UpdateStatus status, IHttpClientFactory http, IConfiguration config, IHostEnvironment env,
    TimeProvider clock, ILogger<UpdateChecker> log) : BackgroundService
{
    public const string DefaultUrl = "https://versions.papyra.app/latest.json";
    private static readonly TimeSpan AfterBoot = TimeSpan.FromSeconds(45);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (!status.Enabled) return;
        try
        {
            // A moment after start, so booting is never slowed by it. Then once a day, at this install's own
            // time of day and never in the quiet hour (see UpdateSchedule).
            var notBefore = clock.GetUtcNow() + AfterBoot;
            var failures = 0;
            while (!stop.IsCancellationRequested)
            {
                var id = InstanceId();
                status.InstanceId = id;
                var state = ReadState();
                var due = UpdateSchedule.Next(clock.GetUtcNow(), state.Last, state.Slot ?? UpdateSchedule.Slot(id), notBefore,
                    () => Random.Shared.Next(0, 600));
                var wait = due - clock.GetUtcNow();
                await Task.Delay(wait > TimeSpan.Zero ? wait : TimeSpan.Zero, clock, stop);

                // A check that got no answer is tried again in an hour (then two, four, six: see RetryDelay).
                // When a retry gets through, the time it got through becomes this install's time of day.
                var retrying = failures > 0;
                if (await CheckNowAsync(stop, adoptTimeOfDay: retrying))
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

    // What is remembered across restarts, so a restart doesn't ask again: when the last check got through, and
    // the time of day this install asks at if a retry moved it off the one its id gave it.
    private sealed record CheckState(DateTimeOffset? Last, TimeSpan? Slot);

    private string StateFile() => Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "update-checked");

    private CheckState ReadState()
    {
        try
        {
            if (!File.Exists(StateFile())) return new CheckState(null, null);
            using var doc = JsonDocument.Parse(File.ReadAllText(StateFile()));
            var last = doc.RootElement.TryGetProperty("last", out var l) && l.ValueKind == JsonValueKind.String && l.TryGetDateTimeOffset(out var at)
                ? at.ToUniversalTime() : (DateTimeOffset?)null;
            var slot = doc.RootElement.TryGetProperty("slot", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt32(out var seconds) && seconds is >= 0 and < 86_400
                ? TimeSpan.FromSeconds(seconds) : (TimeSpan?)null;
            // A time of day inside the quiet hour is never used.
            return new CheckState(last, slot is { } t && t >= UpdateSchedule.QuietStart && t < UpdateSchedule.QuietEnd ? null : slot);
        }
        catch (Exception e) when (e is IOException or JsonException or InvalidOperationException) { return new CheckState(null, null); }
    }

    private void WriteState(CheckState state) =>
        File.WriteAllText(StateFile(), JsonSerializer.Serialize(new
        {
            last = state.Last?.ToString("O", CultureInfo.InvariantCulture),
            slot = state.Slot is { } t ? (int?)t.TotalSeconds : null,
        }));

    /// <summary>
    /// Ask now. Never throws: a server that can't be reached just leaves what we knew. With
    /// <paramref name="adoptTimeOfDay"/>, a check that gets through makes this moment's time of day the one
    /// the install asks at from now on (the retry that worked becomes the new schedule).
    /// </summary>
    public async Task<bool> CheckNowAsync(CancellationToken ct, bool adoptTimeOfDay = false)
    {
        if (!status.Enabled) return false;
        try
        {
            var id = InstanceId();
            status.InstanceId = id;
            var url = config["Papyra:UpdateCheckUrl"] is { Length: > 0 } custom ? custom : DefaultUrl;
            using var client = http.CreateClient("update-check");
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"{url}?id={id}&v={Uri.EscapeDataString(status.Current)}&arch={Arch()}&os={OsFamily()}");
            request.Headers.UserAgent.ParseAdd("Papyra/" + status.Current);
            using var response = await client.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();
            var now = clock.GetUtcNow();
            status.Record(Parse(await response.Content.ReadAsStringAsync(ct)), now.UtcDateTime);
            var slot = adoptTimeOfDay ? TimeSpan.FromSeconds(Math.Floor(now.UtcDateTime.TimeOfDay.TotalSeconds)) : ReadState().Slot;
            WriteState(new CheckState(now, slot));
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or IOException)
        {
            log.LogInformation("Update check didn't get an answer ({Reason}).", e.Message);
            return false;
        }
    }

    /// <summary>The answer, if it is a release with a link we are willing to show.</summary>
    internal static UpdateInfo? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var version = root.TryGetProperty("version", out var v) ? v.GetString() : null;
        if (!SemVer.IsStable(version)) return null;
        var url = root.TryGetProperty("url", out var u) ? u.GetString() : null;
        // Only ever offer a link to the project's own pages, whatever the answer says.
        if (url is null || !(url.StartsWith("https://github.com/lyfie-org/papyra", StringComparison.Ordinal)
                             || url.StartsWith("https://papyra.app", StringComparison.Ordinal)))
            url = "https://github.com/lyfie-org/papyra/releases/latest";
        return new UpdateInfo(version!, url);
    }

    /// <summary>The processor family, coarse: x64, arm64, arm (or "other").</summary>
    internal static string Arch() => System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
    {
        System.Runtime.InteropServices.Architecture.X64 => "x64",
        System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
        System.Runtime.InteropServices.Architecture.Arm => "arm",
        _ => "other",
    };

    /// <summary>The operating system family, coarse: linux, windows, macos (or "other").</summary>
    internal static string OsFamily() =>
        OperatingSystem.IsLinux() ? "linux" : OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "other";

    // A random id, made the first time it is needed and kept beside the other Papyra state.
    private string InstanceId()
    {
        var file = Path.Combine(PapyraPaths.DotPapyra(config, env.ContentRootPath), "instance-id");
        if (File.Exists(file) && Guid.TryParse(File.ReadAllText(file).Trim(), out var existing)) return existing.ToString("D", CultureInfo.InvariantCulture);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var made = Guid.NewGuid().ToString("D", CultureInfo.InvariantCulture);
        File.WriteAllText(file, made);
        return made;
    }
}
