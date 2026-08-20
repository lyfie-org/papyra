using System.Collections.Concurrent;
using System.Diagnostics;

namespace Papyra.Api.Storage;

/// <summary>
/// What kind of work a job is, which decides what can be said about it.
/// </summary>
public enum JobKind
{
    /// <summary>Runs on a timer, and can be asked to run now.</summary>
    Periodic,
    /// <summary>Always on, reacting to events (a file changing, a queue filling).</summary>
    Continuous,
}

/// <summary>One job's last outcome, or null if it has not run since boot.</summary>
public sealed record JobRun(
    DateTime StartedUtc,
    DateTime FinishedUtc,
    bool Ok,
    /// <summary>Plain-language result: "3 notes deleted". Null when there was nothing to say.</summary>
    string? Summary,
    /// <summary>Message from the failure, when it failed.</summary>
    string? Error)
{
    public double DurationMs => (FinishedUtc - StartedUtc).TotalMilliseconds;
}

/// <summary>Everything the Jobs screen needs about one job.</summary>
public sealed record JobStatus(
    string Id,
    string Name,
    string Description,
    JobKind Kind,
    TimeSpan? Interval,
    bool Running,
    JobRun? LastRun);

/// <summary>
/// The one place that knows what Papyra does while nobody is looking.
///
/// Background work was a dozen `BackgroundService`s each with its own timer,
/// its own logging and no way to see any of it: when the Trash last emptied, or
/// whether a sweep had been failing for a week, was a question you answered by
/// reading server logs. Every job now announces itself here, so the answer is a
/// screen instead.
///
/// Registration is by startup order and the instance is a singleton, so this is
/// deliberately small: a dictionary, a per-job lock so a manual run can never
/// overlap a scheduled one, and the last result kept in memory. Nothing is
/// persisted — job history is not the sort of thing worth a migration, and the
/// interesting question ("is it working now?") survives a restart by simply
/// running again.
/// </summary>
public sealed class JobRegistry
{
    private sealed record Entry(
        JobStatus Status,
        Func<CancellationToken, Task<string?>>? Run,
        SemaphoreSlim Gate);

    private readonly ConcurrentDictionary<string, Entry> _jobs = new();
    private readonly ILogger<JobRegistry> _logger;

    public JobRegistry(ILogger<JobRegistry> logger) => _logger = logger;

    /// <summary>
    /// Declare a job that runs on a timer. <paramref name="run"/> does one sweep
    /// and returns a plain-language summary, or null when there is nothing to
    /// report. It is what both the timer and the "Run now" button call, so there
    /// is one code path and no way for them to drift.
    /// </summary>
    public void RegisterPeriodic(
        string id, string name, string description, TimeSpan interval,
        Func<CancellationToken, Task<string?>> run)
    {
        _jobs[id] = new Entry(
            new JobStatus(id, name, description, JobKind.Periodic, interval, Running: false, LastRun: null),
            run,
            new SemaphoreSlim(1, 1));
    }

    /// <summary>
    /// Declare a job that is simply always on. There is nothing to trigger — the
    /// work happens when something else does — so it is listed rather than
    /// controlled.
    /// </summary>
    public void RegisterContinuous(string id, string name, string description)
    {
        _jobs[id] = new Entry(
            new JobStatus(id, name, description, JobKind.Continuous, Interval: null, Running: true, LastRun: null),
            Run: null,
            new SemaphoreSlim(1, 1));
    }

    /// <summary>Every job, in a stable order so the screen doesn't shuffle.</summary>
    public IReadOnlyList<JobStatus> Snapshot() =>
        [.. _jobs.Values.Select(e => e.Status).OrderBy(s => s.Kind).ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)];

    public bool Knows(string id) => _jobs.ContainsKey(id);

    /// <summary>
    /// Run a job's sweep and record what happened. The gate means a manual run
    /// waits for a scheduled one rather than running a second copy over the top —
    /// two Trash purges at once is not a thing anyone wants to debug.
    /// </summary>
    public async Task<JobRun?> RunAsync(string id, CancellationToken ct)
    {
        if (!_jobs.TryGetValue(id, out var entry) || entry.Run is null) return null;

        await entry.Gate.WaitAsync(ct);
        var started = DateTime.UtcNow;
        Mark(id, e => e with { Status = e.Status with { Running = true } });
        var clock = Stopwatch.StartNew();
        try
        {
            var summary = await entry.Run(ct);
            var run = new JobRun(started, started.AddMilliseconds(clock.Elapsed.TotalMilliseconds), true, summary, null);
            Mark(id, e => e with { Status = e.Status with { Running = false, LastRun = run } });
            return run;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutdown, not a fault. Leave the last real result on record rather
            // than painting the screen red because the server was stopped.
            Mark(id, e => e with { Status = e.Status with { Running = false } });
            throw;
        }
        catch (Exception ex)
        {
            // A failing job must not take the host down, and the failure has to be
            // visible somewhere a person will look — which is the whole point of
            // this class.
            _logger.LogWarning(ex, "Job {Job} failed", id);
            var run = new JobRun(started, DateTime.UtcNow, false, null, ex.Message);
            Mark(id, e => e with { Status = e.Status with { Running = false, LastRun = run } });
            return run;
        }
        finally
        {
            entry.Gate.Release();
        }
    }

    private void Mark(string id, Func<Entry, Entry> update)
    {
        _jobs.AddOrUpdate(id, _ => throw new InvalidOperationException($"Unknown job {id}"), (_, e) => update(e));
    }
}

/// <summary>
/// The shape every timed job shared before there was anywhere to put it: wait a
/// moment for boot to settle, then sweep on an interval, and never let one bad
/// sweep end the loop.
///
/// Subclasses give their identity and one <see cref="RunOnceAsync"/>; the timer,
/// the error handling and the reporting live here. That is also why the manual
/// trigger cannot drift from the scheduled run — both call the same method
/// through <see cref="JobRegistry"/>.
/// </summary>
public abstract class PeriodicJob : BackgroundService
{
    private readonly JobRegistry _registry;

    protected PeriodicJob(JobRegistry registry) => _registry = registry;

    /// <summary>Stable id used by the API and the trigger button.</summary>
    protected abstract string JobId { get; }
    /// <summary>What this is called on screen. No jargon — a user reads it.</summary>
    protected abstract string JobName { get; }
    /// <summary>One sentence on what it does and why, in the same plain voice.</summary>
    protected abstract string JobDescription { get; }
    protected abstract TimeSpan Interval { get; }
    /// <summary>How long to wait after boot before the first sweep.</summary>
    protected virtual TimeSpan StartupDelay => TimeSpan.FromSeconds(30);

    /// <summary>One sweep. Returns what to show a person, or null for "nothing to report".</summary>
    protected abstract Task<string?> RunOnceAsync(CancellationToken ct);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _registry.RegisterPeriodic(JobId, JobName, JobDescription, Interval, RunOnceAsync);

        try { await Task.Delay(StartupDelay, stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Interval);
        try
        {
            do
            {
                // Failures are caught and recorded inside the registry, so a bad
                // sweep leaves a visible red mark instead of killing the loop.
                await _registry.RunAsync(JobId, stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* stopping */ }
    }
}
