using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Logging;

namespace Papyra.Tests.Integration;

// Shared WebApplicationFactory for integration tests.
// Each instance gets its own temp storage root so test classes don't bleed state.
public sealed class PapyraWebFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    // A valid 32-byte base64-encoded AES key for test use only.
    internal const string TestDataKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    public string StorageRoot { get; } =
        Path.Combine(Path.GetTempPath(), "papyra-tests-" + Guid.NewGuid().ToString("N"));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Each test class gets isolated storage + index directories to prevent
        // Lucene write-lock conflicts when test classes run in parallel.
        builder.UseSetting("Storage:StorageRoot", StorageRoot);
        builder.UseSetting("Index:Directory", Path.Combine(StorageRoot, "index"));
        builder.UseSetting("PAPYRA_DATA_KEY", TestDataKey);
        // Suppress test console noise from the hosted app's logger.
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(StorageRoot);
        return Task.CompletedTask;
    }

    // xUnit calls this after all tests in the class finish.
    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();
        try { Directory.Delete(StorageRoot, recursive: true); } catch { /* best-effort */ }
    }
}
