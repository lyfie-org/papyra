using System.Text.Json;

namespace Papyra.Api.Services;

// ── AuditService ─────────────────────────────────────────────────────────────
// Append-only JSONL audit log at {storageRoot}/.system/audit.log.
// Covers: login success/failure, logout, 2FA success/failure, role changes,
// 2FA enable/disable. Best-effort — logging never blocks the request.

public sealed class AuditService
{
    private readonly string _logPath;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public AuditService(IConfiguration configuration)
    {
        var storageRoot = configuration["Storage:StorageRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _logPath = Path.Combine(storageRoot, ".system", "audit.log");
    }

    // Fire-and-forget — returns immediately; swallows all exceptions.
    public void Log(string eventType, string username, string ipAddress, string? details = null) =>
        _ = WriteAsync(eventType, username, ipAddress, details);

    private async Task WriteAsync(string eventType, string username, string ipAddress, string? details)
    {
        try
        {
            var entry = new
            {
                timestamp = DateTime.UtcNow,
                eventType,
                username,
                ipAddress,
                details,
            };
            var line = JsonSerializer.Serialize(entry, JsonOpts) + "\n";

            await _lock.WaitAsync();
            try { await File.AppendAllTextAsync(_logPath, line); }
            finally { _lock.Release(); }
        }
        catch
        {
            // Audit failures must never surface to callers
        }
    }
}
