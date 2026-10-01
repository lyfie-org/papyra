using Tesseract;

namespace Papyra.Api.Storage;

// Local-only OCR: the words in a picture (a scanned page, a screenshot, a
// receipt) become searchable text for every note that shows it. Runs as a
// MediaJobQueue handler: the queue decides when, stores the result as a
// sidecar (MediaTextStore) and re-indexes the referencing notes.
//
// Graceful degradation: with no Tesseract `tessdata` configured/present (or a
// native load failure), Enabled is false and nothing is ever queued for it.
// One engine, serialized (Tesseract engines aren't thread-safe, and OCR is
// CPU-heavy) — the queue runs one job at a time anyway.
public sealed class OcrProcessorService : IMediaJobHandler, IDisposable
{
    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"];

    private readonly string? _tessData;
    private readonly ILogger<OcrProcessorService> _logger;
    private readonly Lock _gate = new();
    private TesseractEngine? _engine;
    private bool _broken;

    public OcrProcessorService(IConfiguration config, ILogger<OcrProcessorService> logger)
    {
        _logger = logger;
        var tessData = config["Ocr:TessDataPath"];
        _tessData = !string.IsNullOrWhiteSpace(tessData) && File.Exists(Path.Combine(tessData, "eng.traineddata"))
            ? tessData
            : null;
        if (_tessData is null)
            logger.LogInformation(
                "OCR disabled: no Tesseract eng.traineddata under '{Path}' (set Ocr:TessDataPath to enable).",
                tessData ?? string.Empty);
    }

    public string Kind => MediaTextStore.Ocr;

    public bool Enabled => _tessData is not null && !_broken;

    public bool Accepts(string fileName) =>
        ImageExtensions.Contains(Path.GetExtension(fileName).ToLowerInvariant());

    public Task<string> ExtractAsync(string mediaPath, CancellationToken ct) => Task.Run(() =>
    {
        lock (_gate)
        {
            ct.ThrowIfCancellationRequested();
            var engine = Engine() ?? throw new InvalidOperationException("OCR engine unavailable.");
            using var img = Pix.LoadFromFile(mediaPath);
            using var page = engine.Process(img);
            return page.GetText()?.Trim() ?? string.Empty;
        }
    }, ct);

    private TesseractEngine? Engine()
    {
        if (_engine is not null || _broken || _tessData is null) return _engine;
        try
        {
            _engine = new TesseractEngine(_tessData, "eng", EngineMode.Default);
            _logger.LogInformation("OCR enabled.");
        }
        catch (Exception ex)
        {
            _broken = true;
            _logger.LogWarning(ex, "Failed to initialize Tesseract; OCR disabled.");
        }
        return _engine;
    }

    public void Dispose() => _engine?.Dispose();
}
