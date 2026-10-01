using System.Diagnostics;

namespace Papyra.Api.Storage;

/// <summary>
/// Optional: thumbnails for iPhone HEIC/HEIF photos, which Skia can't decode.
/// Off unless the operator points <c>Media:HeifConvert</c> at libheif's
/// <c>heif-convert</c> (Debian/Ubuntu <c>libheif-examples</c>, Alpine
/// <c>libheif-tools</c>) — a bare command name is looked up on PATH. Most HEIC
/// never reaches the server anyway: the web app converts it to JPEG before
/// upload wherever the browser can decode it.
/// <para>
/// The converter is an external decoder fed uploaded bytes, so it runs with an
/// argument list (no shell), a 20 s limit (killed after), output into the
/// derived-state folder, and only for files the server itself sniffed as HEIF.
/// </para>
/// </summary>
public sealed class HeicConverter
{
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(20);
    private readonly ILogger<HeicConverter> _logger;

    public HeicConverter(IConfiguration config, ILogger<HeicConverter> logger)
    {
        _logger = logger;
        Tool = Resolve(config["Media:HeifConvert"]);
        if (Tool is not null) logger.LogInformation("HEIC thumbnails enabled via {Tool}.", Tool);
    }

    /// <summary>The converter's full path, or null (feature off).</summary>
    public string? Tool { get; }

    public bool Enabled => Tool is not null;

    public static bool IsHeif(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is ".heic" or ".heif";

    /// <summary>Convert to a JPEG at <paramref name="dest"/>. False on any failure (logged).</summary>
    public async Task<bool> ToJpegAsync(string source, string dest, CancellationToken ct)
    {
        if (Tool is null || !IsHeif(source) || !File.Exists(source)) return false;
        var tmp = dest + $".{Guid.NewGuid():N}.tmp.jpg";
        var start = new ProcessStartInfo(Tool)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in (string[])["-q", "90", source, tmp]) start.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(start);
            if (process is null) return false;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(Limit);
            var drainOut = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var drainErr = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                if (ct.IsCancellationRequested) throw;
                _logger.LogWarning("heif-convert timed out on {File}", Path.GetFileName(source));
                return false;
            }
            await Task.WhenAll(drainOut, drainErr);
            if (process.ExitCode != 0 || !File.Exists(tmp) || new FileInfo(tmp).Length == 0)
            {
                _logger.LogWarning("heif-convert failed on {File} (exit {Code})", Path.GetFileName(source), process.ExitCode);
                return false;
            }
            File.Move(tmp, dest, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            _logger.LogWarning(ex, "heif-convert could not run on {File}", Path.GetFileName(source));
            return false;
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    private static string? Resolve(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured)) return null;
        if (Path.IsPathRooted(configured)) return File.Exists(configured) ? configured : null;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            foreach (var name in OperatingSystem.IsWindows()
                         ? (string[])[configured, configured + ".exe", configured + ".cmd"]
                         : [configured])
            {
                var candidate = Path.Combine(dir, name);
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }
}
