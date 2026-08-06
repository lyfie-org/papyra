using System.Collections.Concurrent;
using Tesseract;

namespace Papyra.Api.Storage;

// Local-only OCR: extracts text from images dropped into a tenant's media dir and
// indexes it (Lucene `extractedText`, tied to the parent note) so scanned pages and
// screenshots become full-text searchable. The extracted text lives ONLY in the
// index — a disposable cache — so it's re-derived by re-scanning media on boot if
// the index is ever wiped (zero-DB rule).
//
// Graceful degradation: with no Tesseract `tessdata` configured/present (or a native
// load failure), the service logs once and stays idle. One engine is shared and
// access is serialized (Tesseract engines aren't thread-safe, and OCR is CPU-heavy).
public sealed class OcrProcessorService : BackgroundService
{
    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg"];

    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly VaultState _state;
    private readonly SearchIndexService _search;
    private readonly ILogger<OcrProcessorService> _logger;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<FileSystemWatcher> _watchers = new();
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.OrdinalIgnoreCase);
    private TesseractEngine? _engine;

    public OcrProcessorService(
        IConfiguration config,
        IHostEnvironment env,
        VaultState state,
        SearchIndexService search,
        ILogger<OcrProcessorService> logger)
    {
        _config = config;
        _env = env;
        _state = state;
        _search = search;
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var tessData = _config["Ocr:TessDataPath"];
        if (string.IsNullOrWhiteSpace(tessData) || !File.Exists(Path.Combine(tessData, "eng.traineddata")))
        {
            _logger.LogInformation(
                "OCR disabled: no Tesseract eng.traineddata under '{Path}' (set Ocr:TessDataPath to enable).",
                tessData ?? string.Empty);
            return Task.CompletedTask;
        }

        try
        {
            _engine = new TesseractEngine(tessData, "eng", EngineMode.Default);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to initialize Tesseract; OCR disabled.");
            return Task.CompletedTask;
        }

        var usersDir = PapyraPaths.UsersDir(_config, _env.ContentRootPath);
        if (!Directory.Exists(usersDir)) return Task.CompletedTask;

        foreach (var userDir in Directory.EnumerateDirectories(usersDir))
        {
            var userId = Path.GetFileName(userDir);
            WatchUserMedia(userId);
            ScanExisting(userId); // zero-DB: re-derive OCR for images already on disk
        }

        _logger.LogInformation("OCR enabled; watching {Count} media folder(s).", _watchers.Count);
        return Task.CompletedTask;
    }

    private void WatchUserMedia(string userId)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, userId);
        Directory.CreateDirectory(mediaDir);

        var watcher = new FileSystemWatcher(mediaDir)
        {
            IncludeSubdirectories = false,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size,
        };
        watcher.Created += (_, e) => OnImage(userId, e.FullPath);
        watcher.Renamed += (_, e) => OnImage(userId, e.FullPath);
        watcher.EnableRaisingEvents = true;
        _watchers.Add(watcher);
    }

    private void ScanExisting(string userId)
    {
        var mediaDir = PapyraPaths.UserMediaDir(_config, _env.ContentRootPath, userId);
        if (!Directory.Exists(mediaDir)) return;
        foreach (var file in Directory.EnumerateFiles(mediaDir))
            OnImage(userId, file);
    }

    private void OnImage(string userId, string path)
    {
        if (!ImageExtensions.Contains(Path.GetExtension(path).ToLowerInvariant())) return;
        _ = ProcessAsync(userId, path);
    }

    private async Task ProcessAsync(string userId, string path)
    {
        var key = $"{userId}:{path}";
        if (!_inFlight.TryAdd(key, 0)) return;
        await _gate.WaitAsync(); // one OCR at a time — engine isn't thread-safe + CPU-heavy
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(300)); // let the file finish copying
            var filename = Path.GetFileName(path);
            var parent = _state.Snapshot(userId).FirstOrDefault(n =>
                !n.Trashed && !string.IsNullOrEmpty(n.Body) &&
                n.Body.Contains(filename, StringComparison.OrdinalIgnoreCase));
            if (parent is null) return; // OCR is tied to a note; skip unreferenced media

            var text = ExtractText(path);
            if (string.IsNullOrWhiteSpace(text)) return;

            _search.IndexOcr(userId, $"ocr:{userId}:{filename}", parent.Id, text);
            _logger.LogInformation("OCR indexed {File} → note {NoteId}", filename, parent.Id);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "OCR failed for {Path}", path);
        }
        finally
        {
            _gate.Release();
            _inFlight.TryRemove(key, out _);
        }
    }

    private string? ExtractText(string path)
    {
        using var img = Pix.LoadFromFile(path);
        using var page = _engine!.Process(img);
        return page.GetText()?.Trim();
    }

    public override void Dispose()
    {
        foreach (var w in _watchers) w.Dispose();
        _engine?.Dispose();
        _gate.Dispose();
        base.Dispose();
    }
}
