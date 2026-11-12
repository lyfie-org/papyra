using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

/// <summary>
/// Settings → Instance backup (administrators): where the accounts-and-settings
/// backup goes, a download, and restoring one. And the first-screen
/// "restore whole instance" for a new install. See <see cref="InstanceBackupService"/>.
/// </summary>
public static class InstanceBackupEndpoints
{
    private const long MaxUpload = 256L << 20;

    public sealed record ConfigRequest(
        string? Passphrase, bool Local, int Keep, string? GitRemote, string? GitBranch, string? GitToken);

    public sealed record ApplyRequest(string RestoreId);

    public static void MapInstanceBackup(this WebApplication app)
    {
        var admin = app.MapGroup("/api/instance-backup").RequireAuthorization(p => p.RequireRole("Admin")).WithTags("Admin");

        admin.MapGet("/", (InstanceBackupService backup, InstanceConfigStore config) => StatusAsync(backup, config))
            .WithSummary("Instance backup settings and status")
            .WithDescription("Where the accounts-and-settings backup goes, when it last ran, and the local copies. Never returns the passphrase or the git token.");
        admin.MapPut("/", ConfigureAsync)
            .WithSummary("Change the instance backup settings")
            .WithDescription("Sets the passphrase (12+ characters), the local copy and its retention, and the git remote. A blank token keeps the one already saved.");
        admin.MapPost("/run", RunAsync)
            .WithSummary("Back up now")
            .WithDescription("Runs the same pass as the daily job: a local copy and/or a push to git, as set up.");
        admin.MapGet("/download", DownloadAsync)
            .WithSummary("Download an instance backup")
            .WithDescription("Streams the encrypted accounts-and-settings backup (.papyra-instance), sealed under the backup passphrase.");
        admin.MapPost("/restore/stage", StageAsync).DisableAntiforgery()
            .WithMetadata(new RequestSizeLimitAttribute(MaxUpload)).WithFormOptions(multipartBodyLengthLimit: MaxUpload)
            .WithSummary("Check a backup before restoring it")
            .WithDescription("Decrypts into staging and reports what it holds. Needs the backup file or a git source, the backup passphrase, and your own password. Nothing live changes.");
        admin.MapPost("/restore/apply", ApplyAsync)
            .WithSummary("Restore the staged backup")
            .WithDescription("Replaces every account, setting and key with the staged backup's, then stops the server so it starts on them. What was replaced is kept in .papyra/replaced-by-restore-*.");

        app.MapPost("/api/auth/setup/restore-instance", SetupRestoreAsync).DisableAntiforgery().AllowAnonymous()
            .RequireRateLimiting("auth")
            .WithMetadata(new RequestSizeLimitAttribute(MaxUpload)).WithFormOptions(multipartBodyLengthLimit: MaxUpload)
            .WithTags("Auth").WithSummary("Restore a whole instance on a new install")
            .WithDescription("Only while no account exists. Takes an instance backup (file or git) and its passphrase, queues it, and stops the server so it starts on the restored accounts and settings.");
    }

    private static async Task<IResult> StatusAsync(InstanceBackupService backup, InstanceConfigStore config)
    {
        await config.EnsureLoadedAsync();
        return Results.Ok(backup.Status());
    }

    private static async Task<IResult> ConfigureAsync(
        ConfigRequest body, InstanceBackupService backup, InstanceConfigStore config, CancellationToken ct)
    {
        await config.EnsureLoadedAsync(ct);
        var values = new Dictionary<string, string?>();

        if (!string.IsNullOrEmpty(body.Passphrase))
        {
            if (InstanceBackupService.PassphraseProblem(body.Passphrase) is { } weak)
                return Results.BadRequest(new { error = weak, field = "passphrase" });
            await backup.SetPassphraseAsync(body.Passphrase, ct);
        }

        var remote = body.GitRemote?.Trim() ?? string.Empty;
        if ((body.Local || remote.Length > 0) && !backup.HasPassphrase)
            return Results.BadRequest(new { error = "Choose a backup passphrase first.", field = "passphrase" });

        if (remote.Length > 0)
        {
            var token = string.IsNullOrWhiteSpace(body.GitToken) ? config.Get(InstanceBackupKeys.GitToken) : body.GitToken.Trim();
            var (problem, _) = await Task.Run(() => GitSyncService.Probe(remote, token), ct);
            if (problem is not null) return Results.BadRequest(new { error = problem, field = "gitRemote" });
            values[InstanceBackupKeys.GitRemote] = remote;
            values[InstanceBackupKeys.GitBranch] = string.IsNullOrWhiteSpace(body.GitBranch) ? "main" : body.GitBranch.Trim();
            values[InstanceBackupKeys.GitToken] = token;
        }
        else
        {
            values[InstanceBackupKeys.GitRemote] = string.Empty;
            values[InstanceBackupKeys.GitBranch] = string.Empty;
            values[InstanceBackupKeys.GitToken] = string.Empty;
        }

        values[InstanceBackupKeys.Local] = body.Local ? "true" : string.Empty;
        values[InstanceBackupKeys.Keep] = Math.Clamp(body.Keep, 1, 60).ToString();
        await config.SetAsync(values, ct);
        return Results.Ok(backup.Status());
    }

    private static async Task<IResult> RunAsync(JobRegistry jobs, InstanceBackupService backup, CancellationToken ct)
    {
        if (!backup.HasPassphrase)
            return Results.BadRequest(new { error = "Choose a backup passphrase first." });
        await jobs.RunAsync("instance-backup", ct);
        return Results.Ok(backup.Status());
    }

    private static async Task<IResult> DownloadAsync(InstanceBackupService backup, HttpContext http, CancellationToken ct)
    {
        if (!backup.HasPassphrase)
            return Results.BadRequest(new { error = "Choose a backup passphrase first." });
        http.Response.ContentType = "application/octet-stream";
        http.Response.Headers.ContentDisposition = $"attachment; filename=\"papyra-instance-{DateTime.UtcNow:yyyyMMdd-HHmm}{InstanceBackupService.Extension}\"";
        await backup.WriteBundleAsync(http.Response.Body, ct);
        return Results.Empty;
    }

    private static async Task<IResult> StageAsync(
        HttpRequest request, ClaimsPrincipal principal, AppDbContext db, InstanceBackupService backup, CancellationToken ct)
    {
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a multipart upload." });
        var form = await request.ReadFormAsync(ct);

        // Replacing every account is the most destructive thing an admin can do here.
        var password = form["currentPassword"].ToString();
        if (!int.TryParse(principal.FindFirstValue(ClaimTypes.NameIdentifier), out var uid)
            || await db.Users.FindAsync([uid], ct) is not { } me)
            return Results.Unauthorized();
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(me.PasswordHash) || !BCrypt.Net.BCrypt.Verify(password, me.PasswordHash))
            return Results.Json(new { error = "Your password is incorrect.", field = "currentPassword" }, statusCode: StatusCodes.Status401Unauthorized);

        var (summary, failure) = await StageSourceAsync(form, backup, ct);
        return failure ?? Results.Ok(summary);
    }

    // The backup named by a restore form (a file, or a git repository), checked and staged.
    private static async Task<(InstanceRestoreSummary? Summary, IResult? Failure)> StageSourceAsync(
        IFormCollection form, InstanceBackupService backup, CancellationToken ct)
    {
        var passphrase = form["passphrase"].ToString();
        if (string.IsNullOrEmpty(passphrase))
            return (null, Results.BadRequest(new { error = "Enter the backup passphrase.", field = "passphrase" }));
        try
        {
            if (form["kind"].ToString() == "git")
            {
                var remote = form["remoteUrl"].ToString().Trim();
                if (remote.Length == 0)
                    return (null, Results.BadRequest(new { error = "Enter the repository address.", field = "remoteUrl" }));
                return (await backup.StageRestoreFromGitAsync(
                    remote, form["branch"].ToString(), form["token"].ToString().Trim(), passphrase, ct), null);
            }

            var file = form.Files["file"];
            if (file is null || file.Length == 0)
                return (null, Results.BadRequest(new { error = "Choose the backup file.", field = "file" }));
            await using var stream = file.OpenReadStream();
            return (await backup.StageRestoreAsync(stream, passphrase, ct), null);
        }
        catch (InstanceRestoreException ex)
        {
            return (null, Results.BadRequest(new { error = ex.Message }));
        }
    }

    private static IResult ApplyAsync(ApplyRequest body, InstanceBackupService backup, IHostApplicationLifetime lifetime)
    {
        if (!backup.Queue(body.RestoreId ?? string.Empty))
            return Results.BadRequest(new { error = "That restore is no longer staged. Check the backup again." });
        StopSoon(lifetime);
        return Results.Ok(new { restarting = true });
    }

    private static async Task<IResult> SetupRestoreAsync(
        HttpRequest request, AppDbContext db, InstanceBackupService backup, IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        if (await db.Users.AnyAsync(ct)) return Results.Conflict(new { error = "Already initialized." });
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a multipart upload." });
        var (summary, failure) = await StageSourceAsync(await request.ReadFormAsync(ct), backup, ct);
        if (failure is not null) return failure;

        backup.Queue(summary!.RestoreId);
        StopSoon(lifetime);
        return Results.Ok(summary with { RestoreId = string.Empty });
    }

    // Lets this response reach the browser before the process goes.
    private static void StopSoon(IHostApplicationLifetime lifetime) =>
        _ = Task.Run(async () =>
        {
            await Task.Delay(1500);
            lifetime.StopApplication();
        });
}
