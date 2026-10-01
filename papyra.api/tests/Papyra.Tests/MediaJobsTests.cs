using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Sprint S8 of the media overhaul: text read out of attachments goes through
/// one persisted, retrying queue into sidecars that the search index folds into
/// every referencing note (never a Secure one); the web archiver's card keeps
/// its archive and never repeats; imports never overwrite an attachment and
/// refuse zip bombs; the export streams.
/// </summary>
public sealed class MediaJobsTests
{
    private const string Pw = "hunter2!";
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    /// <summary>OCR without Tesseract: text by the uploaded file's name.</summary>
    private sealed class FakeOcr : IMediaJobHandler
    {
        public int Calls;
        public int FailuresLeft;
        public string Kind => MediaTextStore.Ocr;
        public bool Enabled => true;
        public bool Accepts(string fileName) => fileName.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
        public Task<string> ExtractAsync(string mediaPath, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            if (Interlocked.Decrement(ref FailuresLeft) >= 0) throw new IOException("engine busy");
            var name = Path.GetFileName(mediaPath);
            return Task.FromResult(name.StartsWith("receipt") ? "TOTAL DUE invoicezz42"
                : name.StartsWith("passport") ? "passportzz9 secret"
                : "");
        }
    }

    // ── The queue, OCR sidecars and search ───────────────────────────────────

    [Fact]
    public async Task OcrText_FindsTheNote_SurvivesRebuild_AndNeverASecureOne()
    {
        var ocr = new FakeOcr();
        var (factory, dir) = NewApp(ocr);
        try
        {
            var owner = await OwnerAsync(factory);
            var receipt = await UploadAsync(owner, Png, "receipt.png");
            var passport = await UploadAsync(owner, Png, "passport.png");
            await WriteNoteAsync(owner, "n1", $"Expenses ![[{receipt}|300]]");
            await WriteNoteAsync(owner, "s1", $"Documents ![[{passport}]]", secure: true);

            Assert.True(await EventuallyAsync(async () => (await SearchAsync(owner, "invoicezz42")).Contains("n1")),
                "a word only in the picture never found its note");
            var sidecar = Path.Combine(dir, "users", "1", ".papyra", "media", receipt + ".ocr.txt");
            Assert.Contains("invoicezz42", await File.ReadAllTextAsync(sidecar));

            // The nightly rebuild used to drop every OCR document for good.
            await factory.Services.GetRequiredService<SearchRebuilder>().RebuildUserAsync("1", CancellationToken.None);
            Assert.Contains("n1", await SearchAsync(owner, "invoicezz42"));

            // A Secure note's picture is read (its sidecar exists) but never searchable.
            Assert.True(await EventuallyAsync(() => Task.FromResult(
                File.Exists(Path.Combine(dir, "users", "1", ".papyra", "media", passport + ".ocr.txt")))));
            Assert.Empty(await SearchAsync(owner, "passportzz9"));

            // The toolbar's "Copy text" reads it back; meta says it's there.
            var text = await owner.GetFromJsonAsync<JsonElement>($"/api/media/{receipt}/text");
            Assert.Equal("ocr", text.GetProperty("kind").GetString());
            Assert.Contains("invoicezz42", text.GetProperty("text").GetString());
            var meta = await owner.GetFromJsonAsync<JsonElement>($"/api/media/{receipt}/meta");
            Assert.Equal("ocr", meta.GetProperty("text").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnUpload_IsReadOnlyOnceANoteEmbedsIt()
    {
        var ocr = new FakeOcr();
        var (factory, dir) = NewApp(ocr);
        try
        {
            var owner = await OwnerAsync(factory);
            var receipt = await UploadAsync(owner, Png, "receipt.png");
            await Task.Delay(1500);
            Assert.Equal(0, ocr.Calls);

            await WriteNoteAsync(owner, "n1", $"![[{receipt}]]");
            Assert.True(await EventuallyAsync(() => Task.FromResult(ocr.Calls == 1)));
            // Saving again doesn't read it again.
            await WriteNoteAsync(owner, "n1", $"edited ![[{receipt}]]");
            await Task.Delay(1500);
            Assert.Equal(1, ocr.Calls);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AFailingJob_Retries_ThenGivesUp_AndIsRemembered()
    {
        var ocr = new FakeOcr { FailuresLeft = 1000 };
        var (factory, dir) = NewApp(ocr);
        try
        {
            var queue = factory.Services.GetRequiredService<MediaJobQueue>();
            queue.Backoff = _ => TimeSpan.FromMilliseconds(50);
            queue.Settle = TimeSpan.Zero;
            var owner = await OwnerAsync(factory);
            var receipt = await UploadAsync(owner, Png, "receipt.png");
            await WriteNoteAsync(owner, "n1", $"![[{receipt}]]");

            Assert.True(await EventuallyAsync(() => Task.FromResult(queue.Failed.Count == 1)), "the job never gave up");
            Assert.Equal(MediaJobQueue.MaxAttempts, ocr.Calls);
            Assert.Empty(queue.Pending);
            var saved = Directory.EnumerateFiles(dir, "media-jobs.json", SearchOption.AllDirectories).Single();
            Assert.Contains(receipt, await File.ReadAllTextAsync(saved));

            // Remembered: another save doesn't start it over.
            await WriteNoteAsync(owner, "n1", $"again ![[{receipt}]]");
            await Task.Delay(500);
            Assert.Equal(MediaJobQueue.MaxAttempts, ocr.Calls);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Web archiver ──────────────────────────────────────────────────────────

    private const string Article = """
        <html><head><title>Slow bread, properly</title></head><body><article>
        <h1>Slow bread, properly</h1>
        <p>Bread that rises slowly tastes of more than flour. A long, cool fermentation gives the yeast
        and bacteria time to work, and the crumb becomes open and glossy while the crust darkens and sings.</p>
        <p>Start the evening before. Mix flour, water and a little starter, rest it, then fold it every half
        hour for two hours. Shape it loosely and leave it in the fridge overnight, covered, until morning.</p>
        <p>Bake it in a heavy pot with the lid on for twenty minutes, then uncovered until it is properly
        dark. Let it cool completely before cutting; the inside is still cooking as the steam escapes.</p>
        <p>Every kitchen is different, so keep notes: the temperature of the room, how long it rose, and how
        it looked when it went into the oven. After a few loaves the notes will tell you more than any recipe.</p>
        </article></body></html>
        """;

    [Fact]
    public async Task Archiver_CardKeepsItsArchive_AndAPageIsArchivedOnce()
    {
        var (factory, dir) = NewApp(null);
        try
        {
            var archiver = factory.Services.GetRequiredService<WebArchiverService>();
            var fetches = 0;
            archiver.Fetcher = (_, _) => { Interlocked.Increment(ref fetches); return Task.FromResult<string?>(Article); };
            var owner = await OwnerAsync(factory);
            const string url = "https://example.com/bread";
            await WriteNoteAsync(owner, "n1", $"Read this: {url}");

            var archive = WebArchiverService.ArchiveFileName(url);
            string? body = null;
            Assert.True(await EventuallyAsync(async () => (body = await BodyAsync(owner, "n1"))!.Contains("Saved article")));
            Assert.Contains($"[Saved copy](/api/media/{archive})", body);
            Assert.Contains(archive, MediaRefParser.Extract(body));
            // The card's write kept the prior text recoverable (a snapshot of the note).
            var snapshots = Path.Combine(dir, "users", "1", ".papyra", "snapshots", "n1");
            Assert.True(Directory.Exists(snapshots) && Directory.EnumerateFiles(snapshots).Any(),
                "the archive card was written without a snapshot of the text before it");

            // The card and the file both gone (deleted, or pruned): the page is
            // still never archived again — no second card.
            File.Delete(Path.Combine(dir, "users", "1", "media", archive));
            await WriteNoteAsync(owner, "n1", $"Read this: {url}");
            await Task.Delay(1500);
            Assert.DoesNotContain("Saved article", await BodyAsync(owner, "n1"));
            Assert.Equal(1, fetches);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Import ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Import_NeverOverwritesAnAttachment_AndRepeatsChangeNothing()
    {
        var (factory, dir) = NewApp(null);
        try
        {
            var owner = await OwnerAsync(factory);
            var mediaDir = Path.Combine(dir, "users", "1", "media");
            Directory.CreateDirectory(mediaDir);
            var mine = Png;
            var theirs = Png.Concat(new byte[] { 1, 2, 3 }).ToArray();
            await File.WriteAllBytesAsync(Path.Combine(mediaDir, "photo.png"), mine);

            var vault = Zip(("V/.obsidian/app.json", Encoding.UTF8.GetBytes("{}")),
                ("V/Trip.md", Encoding.UTF8.GetBytes("Look ![[photo.png|300]] and [[photo.png]]")),
                ("V/photo.png", theirs),
                ("V/page.png", Encoding.UTF8.GetBytes("<html><script>alert(1)</script></html>")));

            var first = await ImportAsync(owner, vault);
            Assert.True(first.GetProperty("error").ValueKind == JsonValueKind.Null, first.ToString());
            Assert.Equal(mine, await File.ReadAllBytesAsync(Path.Combine(mediaDir, "photo.png")));
            Assert.Equal(theirs, await File.ReadAllBytesAsync(Path.Combine(mediaDir, "photo-2.png")));
            var trip = (await owner.GetFromJsonAsync<List<Note>>("/api/notes"))!.Single(n => n.Title == "Trip");
            Assert.Equal("Look ![[photo-2.png|300]] and [[photo-2.png]]", trip.Body.Trim());
            // The bytes, not the name, decide what a file is: no "PNG" that is a page.
            Assert.False(File.Exists(Path.Combine(mediaDir, "page.png")));

            // The same archive again (same bytes, same times).
            var again = await ImportAsync(owner, vault);
            Assert.Equal(1, again.GetProperty("unchanged").GetInt32());
            Assert.False(File.Exists(Path.Combine(mediaDir, "photo-3.png")));
        }
        finally { Cleanup(factory, dir); }
    }

    [Theory]
    [InlineData("![[photo.png]]", "![[photo-2.png]]")]
    [InlineData("![[Photo.PNG|A trip|300]] <!-- align:center -->", "![[photo-2.png|A trip|300]] <!-- align:center -->")]
    [InlineData("![[sub/photo.png#x]]", "![[photo-2.png#x]]")]
    [InlineData("| ![[photo.png\\|200]] |", "| ![[photo-2.png\\|200]] |")]
    [InlineData("![alt](sub/photo.png \"t\")", "![alt](photo-2.png \"t\")")]
    [InlineData("![](/api/media/photo.png)", "![](/api/media/photo-2.png)")]
    // Found by MediaFuzzTests: forms Extract counts but Rename used to skip.
    [InlineData("download it at /api/media/photo.png please", "download it at /api/media/photo-2.png please")]
    [InlineData("<img src=\"sub/photo.png\" width=\"300\"> <video poster='photo.png'>", "<img src=\"photo-2.png\" width=\"300\"> <video poster='photo-2.png'>")]
    [InlineData("![](/api/media/photo.png%20)", "![](/api/media/photo-2.png)")]
    [InlineData("![[photo.png.bak]] ![[youtube:https://x.y/photo.png]] [l](https://e.com/photo.png)",
        "![[photo.png.bak]] ![[youtube:https://x.y/photo.png]] [l](https://e.com/photo.png)")]
    public void Rename_PointsReferencesAtTheNewName_AndNothingElse(string body, string expected)
    {
        var renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["photo.png"] = "photo-2.png" };
        Assert.Equal(expected, MediaRefParser.Rename(body, renames));
    }

    [Fact]
    public async Task Import_RefusesAZipBomb_WithAPlainMessage()
    {
        var (factory, dir) = NewApp(null);
        try
        {
            var owner = await OwnerAsync(factory);
            var bomb = Zip(("V/Note.md", Encoding.UTF8.GetBytes("hello")), ("V/big.png", new byte[24 * 1024 * 1024]));
            Assert.True(bomb.Length < 1024 * 1024);
            var status = await ImportAsync(owner, bomb);
            Assert.Contains("expands", status.GetProperty("error").GetString());
            Assert.False(File.Exists(Path.Combine(dir, "users", "1", "media", "big.png")));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Export ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Export_Streams_StoresMediaAsIs_AndCompressesNotes()
    {
        var (factory, dir) = NewApp(null, pin: false);
        try
        {
            var owner = await OwnerAsync(factory, pin: false);
            var picture = await UploadAsync(owner, Png, "photo.png");
            await WriteNoteAsync(owner, "n1", string.Concat(Enumerable.Repeat("All work and no play. ", 400)) + $"![[{picture}]]");

            var ticket = (await (await owner.PostAsJsonAsync("/api/export/authorize", new { code = await TestAuth.CodeAsync(owner) }))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString();
            var res = await owner.GetAsync($"/api/export?ticket={ticket}", HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("application/zip", res.Content.Headers.ContentType?.MediaType);

            using var zip = new ZipArchive(new MemoryStream(await res.Content.ReadAsByteArrayAsync()));
            var media = zip.Entries.Single(e => e.FullName == $"media/{picture}");
            Assert.Equal(media.Length, media.CompressedLength); // stored, not recompressed
            var note = zip.Entries.Single(e => e.FullName.EndsWith(".md") && !e.FullName.StartsWith("media/"));
            Assert.True(note.CompressedLength < note.Length / 4);
            // Nothing left behind in temp: the archive was never a file.
            Assert.DoesNotContain(Directory.EnumerateFiles(Path.GetTempPath(), "papyra-export-*.zip"),
                f => File.GetCreationTimeUtc(f) > DateTime.UtcNow.AddMinutes(-1));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Export_OfALargeVault_StartsAtOnce()
    {
        var (factory, dir) = NewApp(null, pin: false);
        try
        {
            var owner = await OwnerAsync(factory, pin: false);
            await WriteNoteAsync(owner, "n1", "hello");
            // 1 GB of attachments written straight to disk (a filled-in vault).
            var mediaDir = Path.Combine(dir, "users", "1", "media");
            Directory.CreateDirectory(mediaDir);
            for (var i = 0; i < 4; i++)
            {
                await using var fs = new FileStream(Path.Combine(mediaDir, $"video-{i}.mp4"), FileMode.CreateNew);
                fs.SetLength(256L * 1024 * 1024);
            }

            var ticket = (await (await owner.PostAsJsonAsync("/api/export/authorize", new { code = await TestAuth.CodeAsync(owner) }))
                .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString();
            var clock = System.Diagnostics.Stopwatch.StartNew();
            using var res = await owner.GetAsync($"/api/export?ticket={ticket}", HttpCompletionOption.ResponseHeadersRead);
            await using var body = await res.Content.ReadAsStreamAsync();
            var first = new byte[64 * 1024];
            var read = await body.ReadAsync(first);
            var firstByte = clock.Elapsed;
            Assert.True(read > 0);
            // The old export zipped everything to a temp file first: on 1 GB that
            // is seconds of silence, on 5 GB a minute.
            Assert.True(firstByte < TimeSpan.FromSeconds(2), $"first byte after {firstByte.TotalMilliseconds:0} ms");
            long total = read;
            var buffer = new byte[1024 * 1024];
            while ((read = await body.ReadAsync(buffer)) > 0) total += read;
            Assert.True(total > 1024L * 1024 * 1024);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(IMediaJobHandler? handler, bool pin = true)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-jobs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            if (handler is not null) b.ConfigureServices(s => s.AddSingleton(handler));
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> OwnerAsync(WebApplicationFactory<Program> factory, bool pin = true)
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
        if (pin) await TestAuth.SetVaultPinAsync(client, Pw);
        return client;
    }

    private static async Task<string> UploadAsync(HttpClient client, byte[] bytes, string name)
    {
        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", name } };
        var res = await client.PostAsync("/api/media/upload", form);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("filename").GetString()!;
    }

    private static async Task WriteNoteAsync(HttpClient client, string id, string body, bool secure = false) =>
        Assert.True((await client.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite(
            "N", null, null, false, false, body, Kind: null, Secure: secure))).IsSuccessStatusCode);

    private static async Task<string> BodyAsync(HttpClient client, string id) =>
        (await client.GetFromJsonAsync<List<Note>>("/api/notes"))!.Single(n => n.Id == id).Body;

    private static async Task<List<string>> SearchAsync(HttpClient client, string q) =>
        (await client.GetFromJsonAsync<List<JsonElement>>($"/api/search?q={Uri.EscapeDataString(q)}"))!
            .Select(e => e.GetProperty("id").GetString()!).ToList();

    private static async Task<bool> EventuallyAsync(Func<Task<bool>> test, int timeoutMs = 15_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (await test()) return true;
            await Task.Delay(150);
        }
        return await test();
    }

    private static byte[] Zip(params (string Name, byte[] Content)[] entries)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                var e = zip.CreateEntry(name, CompressionLevel.Optimal);
                using var w = e.Open();
                w.Write(content);
            }
        }
        return ms.ToArray();
    }

    private static async Task<JsonElement> ImportAsync(HttpClient client, byte[] zip)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(zip);
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
        form.Add(file, "file", "import.zip");
        var res = await client.PostAsync("/api/import/obsidian", form);
        Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);
        var jobId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString();
        for (var i = 0; i < 200; i++)
        {
            var status = await client.GetFromJsonAsync<JsonElement>("/api/import/status");
            if (status.GetProperty("jobId").GetString() == jobId && status.GetProperty("done").GetBoolean())
                return status;
            await Task.Delay(100);
        }
        throw new TimeoutException("Import never finished.");
    }
}
