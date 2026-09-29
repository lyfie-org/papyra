using System.ComponentModel;
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

namespace Papyra.Api.Collab;

/// <summary>
/// Runs the embedded collab engine (papyra.collab, bundled as
/// <c>collab/server.mjs</c>) as a child process of the API — no second
/// container, nothing for a self-hoster to install or configure.
///
/// Lifecycle: wait until Kestrel is listening (the engine calls back into the
/// API's internal endpoints), start <c>node collab/server.mjs</c> on a random
/// loopback port with a per-boot secret, read its
/// <c>PAPYRA_COLLAB_READY port=N</c> handshake, and restart it with backoff if
/// it dies. On shutdown its stdin is closed, which makes it save open rooms and
/// exit; it is killed only if it doesn't within the grace period.
///
/// Anything going wrong (Node missing, bundle missing, crash loop) only
/// degrades: notes fall back to the classic autosave editor.
/// </summary>
public sealed class CollabHost(
    CollabOptions options,
    CollabEngine engine,
    IServer server,
    IHostApplicationLifetime lifetime,
    IHostEnvironment env,
    IHttpClientFactory http,
    ILogger<CollabHost> logger) : BackgroundService
{
    private const string ReadyPrefix = "PAPYRA_COLLAB_READY port=";
    private static readonly TimeSpan ShutdownGrace = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan HealthyRun = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Enabled)
        {
            engine.SetState(CollabStatus.Disabled, null);
            logger.LogInformation("Live collaboration is turned off (Features:Collab=false).");
            return;
        }

        if (options.Url is { } url)
        {
            await WatchExternalEngineAsync(new Uri(url.TrimEnd('/') + "/"), stoppingToken);
            return;
        }

        var script = Path.IsPathRooted(options.Script)
            ? options.Script
            : Path.Combine(env.ContentRootPath, options.Script);
        if (!File.Exists(script))
        {
            engine.SetState(CollabStatus.Degraded, null);
            logger.LogInformation("Collab engine not bundled at {Script}; live editing is off.", script);
            return;
        }

        if (!await WaitForStartAsync(stoppingToken)) return;
        var apiUrl = LoopbackApiUrl();
        if (apiUrl is null)
        {
            engine.SetState(CollabStatus.Degraded, null);
            logger.LogWarning("Could not determine the API's own address; live editing is off.");
            return;
        }

        var backoff = TimeSpan.FromSeconds(1);
        while (!stoppingToken.IsCancellationRequested)
        {
            var started = DateTime.UtcNow;
            try
            {
                await RunOnceAsync(script, apiUrl, stoppingToken);
            }
            catch (Win32Exception ex)
            {
                // Node isn't installed (bare-metal run) — nothing to restart soon.
                logger.LogWarning("Cannot start the collab engine ({Node}): {Message}. Live editing is off.",
                    options.NodePath, ex.Message);
                backoff = MaxBackoff;
            }
            engine.SetState(CollabStatus.Degraded, null);
            if (stoppingToken.IsCancellationRequested) break;

            if (DateTime.UtcNow - started > HealthyRun) backoff = TimeSpan.FromSeconds(1);
            logger.LogWarning("Collab engine stopped; restarting in {Delay}s.", backoff.TotalSeconds);
            try { await Task.Delay(backoff, stoppingToken); } catch (OperationCanceledException) { break; }
            backoff = TimeSpan.FromTicks(Math.Min(backoff.Ticks * 2, MaxBackoff.Ticks));
        }
    }

    private async Task RunOnceAsync(string script, string apiUrl, CancellationToken stoppingToken)
    {
        var start = new ProcessStartInfo(options.NodePath)
        {
            ArgumentList = { script },
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(script)!,
        };
        start.Environment["PAPYRA_COLLAB_SECRET"] = options.Secret;
        start.Environment["PAPYRA_API_URL"] = apiUrl;
        start.Environment["PAPYRA_COLLAB_PORT"] = "0";
        start.Environment["PAPYRA_COLLAB_EXIT_WITH_PARENT"] = "1";
        start.Environment["NODE_ENV"] = "production";

        using var process = Process.Start(start) ?? throw new Win32Exception("Process.Start returned null");
        logger.LogInformation("Collab engine starting (pid {Pid}).", process.Id);

        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            if (e.Data.StartsWith(ReadyPrefix, StringComparison.Ordinal)
                && int.TryParse(e.Data.AsSpan(ReadyPrefix.Length), out var port))
            {
                engine.SetState(CollabStatus.Ok, new Uri($"http://127.0.0.1:{port}/"));
                logger.LogInformation("Collab engine ready on loopback port {Port}.", port);
                return;
            }
            logger.LogInformation("{Line}", e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) logger.LogWarning("{Line}", e.Data);
        };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        try
        {
            await process.WaitForExitAsync(stoppingToken);
            logger.LogWarning("Collab engine exited with code {Code}.", process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            // Shutting down: closing stdin tells the engine to save open rooms and exit.
            engine.SetState(CollabStatus.Degraded, null);
            try { process.StandardInput.Close(); } catch (IOException) { }
            using var grace = new CancellationTokenSource(ShutdownGrace);
            try { await process.WaitForExitAsync(grace.Token); }
            catch (OperationCanceledException)
            {
                logger.LogWarning("Collab engine did not stop in time; killing it.");
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            }
        }
    }

    // A hand-started engine (dev): just track whether it answers.
    private async Task WatchExternalEngineAsync(Uri baseUrl, CancellationToken stoppingToken)
    {
        var client = http.CreateClient(CollabEngine.HttpClientName);
        var last = (CollabStatus?)null;
        while (!stoppingToken.IsCancellationRequested)
        {
            var status = CollabStatus.Degraded;
            try
            {
                using var response = await client.GetAsync(new Uri(baseUrl, "healthz"), stoppingToken);
                if (response.IsSuccessStatusCode) status = CollabStatus.Ok;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { }
            engine.SetState(status, status == CollabStatus.Ok ? baseUrl : null);
            if (status != last) logger.LogInformation("Collab engine at {Url}: {Status}.", baseUrl, status);
            last = status;
            try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); } catch (OperationCanceledException) { }
        }
    }

    private async Task<bool> WaitForStartAsync(CancellationToken stoppingToken)
    {
        var started = new TaskCompletionSource();
        using var onStarted = lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        using var onStopping = stoppingToken.Register(() => started.TrySetCanceled());
        try { await started.Task; return true; }
        catch (TaskCanceledException) { return false; }
    }

    // The engine calls the API's internal endpoints over loopback, on whatever
    // port Kestrel actually bound (ASPNETCORE_URLS=http://+:8080 in the image).
    private string? LoopbackApiUrl()
    {
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses;
        var address = addresses?.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                      ?? addresses?.FirstOrDefault();
        if (address is null) return null;
        var uri = new Uri(address.Replace("://+", "://localhost").Replace("://*", "://localhost")
            .Replace("://[::]", "://localhost").Replace("://0.0.0.0", "://localhost"));
        return $"{uri.Scheme}://127.0.0.1:{uri.Port}";
    }
}
