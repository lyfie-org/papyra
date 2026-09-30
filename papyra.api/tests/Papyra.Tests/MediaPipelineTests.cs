using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using SkiaSharp;

namespace Papyra.Tests;

/// <summary>
/// Sprint S1 of the media overhaul: uploads stream to disk (limited by what the
/// bytes are, as they arrive), every attachment gets metadata the editor can lay
/// out with before anything loads, and pictures get small, upright, EXIF-free
/// WebP thumbnails that cache forever.
/// </summary>
public sealed class MediaPipelineTests
{
    private const string Pw = "hunter2!";

    // ── Upload ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Upload_ReportsShape_AndRecordsTheContentHash()
    {
        await using var app = await App.StartAsync();
        var png = Png(400, 300);
        var up = await app.UploadAsync(png, "Holiday Photo.PNG");

        Assert.EndsWith(".png", up.GetProperty("filename").GetString());
        Assert.StartsWith("holiday-photo-", up.GetProperty("filename").GetString());
        Assert.Equal("image", up.GetProperty("kind").GetString());
        Assert.Equal(400, up.GetProperty("width").GetInt32());
        Assert.Equal(300, up.GetProperty("height").GetInt32());
        Assert.True(up.GetProperty("thumb").GetBoolean());

        var hash = Convert.ToHexStringLower(SHA256.HashData(png));
        Assert.Equal(hash[..16], up.GetProperty("version").GetString());
        var metaFile = Path.Combine(app.Dir, "users", "1", ".papyra", "media", up.GetProperty("filename").GetString() + ".meta.json");
        Assert.Contains(hash, await File.ReadAllTextAsync(metaFile));
    }

    [Fact]
    public async Task Limits_AreServedFromTheSameTable_TheUploadEnforces()
    {
        await using var app = await App.StartAsync();
        var res = await app.Owner.GetAsync("/api/media/limits");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await app.ReadAsync(res);
        var limits = body.GetProperty("limits");
        Assert.Equal(Papyra.Api.Storage.MediaLimits.Image, limits.GetProperty("image").GetInt64());
        Assert.Equal(Papyra.Api.Storage.MediaLimits.Video, limits.GetProperty("video").GetInt64());
        Assert.Equal(Papyra.Api.Storage.MediaLimits.Other, limits.GetProperty("other").GetInt64());
        var images = body.GetProperty("extensions").GetProperty("image").EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Contains(".heic", images);
        Assert.DoesNotContain(".mp4", images);

        using var anonymous = app.Factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/media/limits")).StatusCode);
    }

    [Fact]
    public async Task Upload_OverItsKindsLimit_IsRefusedMidStream_AndLeavesNothing()
    {
        await using var app = await App.StartAsync();
        // 31 MB that sniffs as a PNG: over the 30 MB image limit, well under the
        // route's ceiling — only the per-kind check can refuse it.
        var big = new byte[31 * 1024 * 1024];
        Png(2, 2).CopyTo(big, 0);
        using var form = new MultipartFormDataContent { { new ByteArrayContent(big), "file", "huge.mp4" } };
        var res = await app.Owner.PostAsync("/api/media/upload", form);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
        Assert.Contains("image", await res.Content.ReadAsStringAsync());
        var media = Path.Combine(app.Dir, "users", "1", "media");
        Assert.True(!Directory.Exists(media) || Directory.GetFiles(media).Length == 0);
    }

    [Fact]
    public async Task Upload_RefusesMalformedAndEmptyBodies()
    {
        await using var app = await App.StartAsync();
        var empty = new MultipartFormDataContent { { new ByteArrayContent([]), "file", "x.png" } };
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Owner.PostAsync("/api/media/upload", empty)).StatusCode);

        var none = new MultipartFormDataContent { { new StringContent("hi"), "other" } };
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Owner.PostAsync("/api/media/upload", none)).StatusCode);

        var two = new MultipartFormDataContent
        {
            { new ByteArrayContent(Png(2, 2)), "file", "a.png" },
            { new ByteArrayContent(Png(2, 2)), "file", "b.png" },
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Owner.PostAsync("/api/media/upload", two)).StatusCode);

        var json = new StringContent("{}", Encoding.UTF8, "application/json");
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Owner.PostAsync("/api/media/upload", json)).StatusCode);
    }

    [Fact]
    public async Task VideoUpload_KeepsTheBrowsersPoster_AndClampedMeasurements()
    {
        await using var app = await App.StartAsync();
        var mp4 = Convert.FromHexString("000000186674797069736F6D0000020069736F6D00000008667265650000000C6D64617400000000");
        using var form = new MultipartFormDataContent
        {
            { new ByteArrayContent(mp4), "file", "clip.mp4" },
            { new ByteArrayContent(Png(640, 360)), "poster", "poster.png" },
            { new StringContent("{\"width\":1920,\"height\":1080,\"durationMs\":5000}"), "meta" },
        };
        var up = await app.ReadAsync(await app.Owner.PostAsync("/api/media/upload", form));
        Assert.Equal("video", up.GetProperty("kind").GetString());
        Assert.Equal(1920, up.GetProperty("width").GetInt32());
        Assert.Equal(1080, up.GetProperty("height").GetInt32());
        Assert.Equal(5000, up.GetProperty("durationMs").GetInt64());
        Assert.True(up.GetProperty("poster").GetBoolean());
        Assert.True(up.GetProperty("thumb").GetBoolean());

        // A video's thumbnail is its poster, resized.
        var thumb = await app.Owner.GetAsync($"/api/media/{up.GetProperty("filename").GetString()}/thumb?w=320");
        Assert.Equal(HttpStatusCode.OK, thumb.StatusCode);
        var (w, h) = Size(await thumb.Content.ReadAsByteArrayAsync());
        Assert.Equal((320, 180), (w, h));

        // Nonsense measurements and a poster that isn't a picture are ignored, not fatal.
        using var junk = new MultipartFormDataContent
        {
            { new ByteArrayContent(mp4), "file", "clip.mp4" },
            { new StringContent("<script>alert(1)</script>"), "poster", "p.html" },
            { new StringContent("{\"width\":999999,\"height\":-5,\"durationMs\":\"x\"}"), "meta" },
        };
        var bad = await app.ReadAsync(await app.Owner.PostAsync("/api/media/upload", junk));
        Assert.False(bad.GetProperty("poster").GetBoolean());
        Assert.Equal(JsonValueKind.Null, bad.GetProperty("width").ValueKind);
        Assert.Equal(JsonValueKind.Null, bad.GetProperty("durationMs").ValueKind);
    }

    // ── Thumbnails ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Thumb_IsASnappedWebp_CachedForeverWhenVersioned_AndRevalidatable()
    {
        await using var app = await App.StartAsync();
        var up = await app.UploadAsync(Png(1000, 500), "wide.png");
        var name = up.GetProperty("filename").GetString()!;
        var version = up.GetProperty("version").GetString()!;

        var res = await app.Owner.GetAsync($"/api/media/{name}/thumb?w=300&v={version}");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("image/webp", res.Content.Headers.ContentType?.MediaType);
        Assert.Equal((320, 160), Size(await res.Content.ReadAsByteArrayAsync())); // 300 → 320 bucket
        Assert.True(res.Headers.CacheControl?.Private);
        Assert.Contains("immutable", res.Headers.CacheControl!.ToString());

        var unversioned = await app.Owner.GetAsync($"/api/media/{name}/thumb?w=320");
        Assert.True(unversioned.Headers.CacheControl?.NoCache);
        var again = new HttpRequestMessage(HttpMethod.Get, $"/api/media/{name}/thumb?w=320");
        again.Headers.IfNoneMatch.Add(unversioned.Headers.ETag!);
        Assert.Equal(HttpStatusCode.NotModified, (await app.Owner.SendAsync(again)).StatusCode);

        // Absurd widths snap to the largest bucket; small sources are never upscaled.
        Assert.Equal((1000, 500), Size(await (await app.Owner.GetAsync($"/api/media/{name}/thumb?w=99999")).Content.ReadAsByteArrayAsync()));
        var small = (await app.UploadAsync(Png(100, 50), "small.png")).GetProperty("filename").GetString();
        Assert.Equal((100, 50), Size(await (await app.Owner.GetAsync($"/api/media/{small}/thumb?w=1280")).Content.ReadAsByteArrayAsync()));
    }

    // Where the stored top-left (red) corner must appear once shown upright.
    [Theory]
    [InlineData(1, 400, 200, "TL")]
    [InlineData(2, 400, 200, "TR")]
    [InlineData(3, 400, 200, "BR")]
    [InlineData(4, 400, 200, "BL")]
    [InlineData(5, 200, 400, "TL")]
    [InlineData(6, 200, 400, "TR")]
    [InlineData(7, 200, 400, "BR")]
    [InlineData(8, 200, 400, "BL")]
    public async Task Thumb_AppliesExifOrientation_AndStripsExif(int orientation, int width, int height, string redCorner)
    {
        await using var app = await App.StartAsync();
        // Stored 400×200, top-left pixel red, rest blue: the EXIF tag says how to show it.
        var up = await app.UploadAsync(JpegWithOrientation(400, 200, orientation), "phone.jpg");
        Assert.Equal(width, up.GetProperty("width").GetInt32());
        Assert.Equal(height, up.GetProperty("height").GetInt32());

        var bytes = await (await app.Owner.GetAsync($"/api/media/{up.GetProperty("filename").GetString()}/thumb?w=160")).Content.ReadAsByteArrayAsync();
        var (w, h) = Size(bytes);
        Assert.Equal(160, w);
        Assert.Equal(160 * height / width, h);
        Assert.DoesNotContain("Exif", Encoding.ASCII.GetString(bytes));

        using var shown = SKBitmap.Decode(bytes);
        var corners = new Dictionary<string, SKColor>
        {
            ["TL"] = shown.GetPixel(2, 2),
            ["TR"] = shown.GetPixel(w - 3, 2),
            ["BL"] = shown.GetPixel(2, h - 3),
            ["BR"] = shown.GetPixel(w - 3, h - 3),
        };
        foreach (var (corner, color) in corners)
        {
            var red = color.Red > 180 && color.Blue < 90;
            Assert.True(red == (corner == redCorner), $"orientation {orientation}: {corner} is {color}, expected red only at {redCorner}");
        }
    }

    [Fact]
    public async Task Thumb_OfSomethingTheServerCantDraw_Is404WithAReason()
    {
        await using var app = await App.StartAsync();
        var svg = await app.UploadAsync(Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), "i.svg");
        var res = await app.Owner.GetAsync($"/api/media/{svg.GetProperty("filename").GetString()}/thumb");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("unsupported", res.Headers.GetValues("X-Papyra-Reason").Single());
        Assert.False(svg.GetProperty("thumb").GetBoolean());

        // A "PNG" whose header claims absurd dimensions is refused, not decoded.
        var bomb = Png(2, 2);
        bomb[16] = 0x00; bomb[17] = 0x01; bomb[18] = 0x86; bomb[19] = 0xA0; // width 100000
        bomb[20] = 0x00; bomb[21] = 0x01; bomb[22] = 0x86; bomb[23] = 0xA0; // height 100000
        var up = await app.UploadAsync(bomb, "bomb.png");
        Assert.Equal(HttpStatusCode.NotFound,
            (await app.Owner.GetAsync($"/api/media/{up.GetProperty("filename").GetString()}/thumb")).StatusCode);
    }

    // ── Metadata ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Meta_OneAndBatch_AndItSurvivesLosingItsCache()
    {
        await using var app = await App.StartAsync();
        var a = (await app.UploadAsync(Png(64, 32), "a.png")).GetProperty("filename").GetString()!;

        var one = await app.Owner.GetFromJsonAsync<JsonElement>($"/api/media/{a}/meta");
        Assert.Equal(64, one.GetProperty("width").GetInt32());

        var batch = await app.ReadAsync(await app.Owner.PostAsJsonAsync("/api/media/meta", new { names = new[] { a, "missing.png" } }));
        Assert.Equal(32, batch.GetProperty(a).GetProperty("height").GetInt32());
        Assert.Equal(JsonValueKind.Null, batch.GetProperty("missing.png").ValueKind);

        var tooMany = Enumerable.Range(0, 201).Select(i => $"f{i}.png").ToArray();
        Assert.Equal(HttpStatusCode.BadRequest, (await app.Owner.PostAsJsonAsync("/api/media/meta", new { names = tooMany })).StatusCode);

        // Derived state is disposable: delete it and it comes back from the file.
        Directory.Delete(Path.Combine(app.Dir, "users", "1", ".papyra", "media"), recursive: true);
        var rebuilt = await app.Owner.GetFromJsonAsync<JsonElement>($"/api/media/{a}/meta");
        Assert.Equal(64, rebuilt.GetProperty("width").GetInt32());
    }

    [Fact]
    public async Task Meta_IsCaseInsensitive_LikeObsidianEmbeds()
    {
        await using var app = await App.StartAsync();
        var name = (await app.UploadAsync(Png(8, 8), "Mixed.png")).GetProperty("filename").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await app.Owner.GetAsync($"/api/media/{name.ToUpperInvariant()}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await app.Owner.GetAsync($"/api/media/{name.ToUpperInvariant()}/meta")).StatusCode);
    }

    // ── Shares ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ShareLink_ThumbAndMeta_AreScopedLikeTheOriginal()
    {
        await using var app = await App.StartAsync();
        var shared = (await app.UploadAsync(Png(200, 100), "s.png")).GetProperty("filename").GetString()!;
        var other = (await app.UploadAsync(Png(200, 100), "o.png")).GetProperty("filename").GetString()!;
        await app.Owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("N", null, null, false, false, $"![[{shared}]]"));
        await app.Owner.PutAsJsonAsync("/api/notes/n2", new NoteWrite("N", null, null, false, false, $"![[{other}]]"));
        var link = await app.ReadAsync(await app.Owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
            Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: null, MaxViews: null)));
        var token = link.GetProperty("token").GetString();
        var anon = app.Factory.CreateClient();

        var thumb = await anon.GetAsync($"/api/shared/{token}/media/{shared}/thumb?w=160");
        Assert.Equal(HttpStatusCode.OK, thumb.StatusCode);
        Assert.True(thumb.Headers.CacheControl?.NoCache); // a share can be revoked: never cached as immutable
        Assert.Equal(HttpStatusCode.OK, (await anon.GetAsync($"/api/shared/{token}/media/{shared}/meta")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/shared/{token}/media/{other}/thumb")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/shared/{token}/media/{other}/meta")).StatusCode);

        var batch = await app.ReadAsync(await anon.PostAsJsonAsync($"/api/shared/{token}/media/meta",
            new { names = new[] { shared, other } }));
        Assert.Equal(200, batch.GetProperty(shared).GetProperty("width").GetInt32());
        Assert.Equal(JsonValueKind.Null, batch.GetProperty(other).ValueKind);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static byte[] Png(int w, int h)
    {
        using var bmp = new SKBitmap(w, h);
        bmp.Erase(new SKColor(0x7a, 0xaa, 0x8a));
        using var img = SKImage.FromBitmap(bmp);
        return img.Encode(SKEncodedImageFormat.Png, 100).ToArray();
    }

    // A JPEG with an EXIF APP1 segment carrying only the Orientation tag.
    private static byte[] JpegWithOrientation(int w, int h, int orientation)
    {
        using var bmp = new SKBitmap(w, h);
        bmp.Erase(SKColors.Blue);
        using (var canvas = new SKCanvas(bmp)) canvas.DrawRect(0, 0, 20, 20, new SKPaint { Color = SKColors.Red });
        using var img = SKImage.FromBitmap(bmp);
        var jpeg = img.Encode(SKEncodedImageFormat.Jpeg, 90).ToArray();
        byte[] tiff =
        [
            (byte)'M', (byte)'M', 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x01,
            0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, (byte)orientation, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ];
        var payload = Encoding.ASCII.GetBytes("Exif\0\0").Concat(tiff).ToArray();
        var length = payload.Length + 2;
        var app1 = new byte[] { 0xFF, 0xE1, (byte)(length >> 8), (byte)length }.Concat(payload);
        return jpeg.Take(2).Concat(app1).Concat(jpeg.Skip(2)).ToArray();
    }

    private static (int W, int H) Size(byte[] image)
    {
        using var codec = SKCodec.Create(new MemoryStream(image));
        Assert.NotNull(codec);
        return (codec.Info.Width, codec.Info.Height);
    }

    private sealed class App : IAsyncDisposable
    {
        public required WebApplicationFactory<Program> Factory { get; init; }
        public required HttpClient Owner { get; init; }
        public required string Dir { get; init; }

        public static async Task<App> StartAsync()
        {
            var dir = Path.Combine(Path.GetTempPath(), "papyra-pipeline-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            {
                b.UseEnvironment("Development");
                b.UseSetting("Papyra:DataDir", dir);
            });
            var owner = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await owner.PostSetupAsync(new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
            return new App { Factory = factory, Owner = owner, Dir = dir };
        }

        public async Task<JsonElement> UploadAsync(byte[] bytes, string name)
        {
            using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", name } };
            return await ReadAsync(await Owner.PostAsync("/api/media/upload", form));
        }

        public async Task<JsonElement> ReadAsync(HttpResponseMessage res)
        {
            Assert.True(res.IsSuccessStatusCode, $"{(int)res.StatusCode}: {await res.Content.ReadAsStringAsync()}");
            return await res.Content.ReadFromJsonAsync<JsonElement>();
        }

        public ValueTask DisposeAsync()
        {
            Factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(Dir, recursive: true); } catch (IOException) { }
            return ValueTask.CompletedTask;
        }
    }
}

/// <summary>
/// The shared fixture (tests/fixtures/media-refs.json) the web app's parser twin
/// also runs, so the server and the editor agree on what a note embeds.
/// </summary>
public sealed class MediaRefFixtureTests
{
    public static IEnumerable<object[]> Cases()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "fixtures", "media-refs.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return [c.GetProperty("name").GetString()!, c.GetRawText()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Parser_MatchesTheSharedFixture(string name, string json)
    {
        using var doc = JsonDocument.Parse(json);
        var c = doc.RootElement;
        var refs = Papyra.Api.Storage.MediaRefParser.Extract(c.GetProperty("body").GetString());
        foreach (var expected in c.GetProperty("refs").EnumerateArray())
            Assert.True(refs.Contains(expected.GetString()!), $"{name}: missing {expected}");
        if (c.TryGetProperty("not", out var not))
            foreach (var absent in not.EnumerateArray())
                Assert.False(refs.Contains(absent.GetString()!), $"{name}: should not contain {absent}");
    }
}
