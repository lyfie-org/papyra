using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using SkiaSharp;

namespace Papyra.Tests;

/// <summary>
/// Optional HEIC thumbnails (S9): off by default (HEIC stays a card, its thumb
/// 404s), and with <c>Media:HeifConvert</c> pointing at a converter the photo
/// gets a size and thumbnails. The converter here is a stand-in script that
/// "converts" by copying a known picture — libheif isn't installed on the test
/// machine; the contract (argument list, output path, exit code) is the same.
/// </summary>
public sealed class HeicConverterTests
{
    private const string Pw = "hunter2!";

    // The start of an iPhone photo: an ISO-BMFF `ftyp` box with the heic brand.
    private static readonly byte[] Heic =
    [
        0, 0, 0, 0x18, (byte)'f', (byte)'t', (byte)'y', (byte)'p', (byte)'h', (byte)'e', (byte)'i', (byte)'c',
        0, 0, 0, 0, (byte)'m', (byte)'i', (byte)'f', (byte)'1', (byte)'h', (byte)'e', (byte)'i', (byte)'c',
        .. new byte[512],
    ];

    [Fact]
    public async Task WithoutAConverter_HeicHasNoThumbnail()
    {
        var (factory, dir) = NewApp(converter: null);
        try
        {
            var owner = await OwnerAsync(factory);
            var name = await UploadAsync(owner, Heic, "IMG_0001.HEIC");
            Assert.EndsWith(".heic", name);
            var meta = await owner.GetFromJsonAsync<JsonElement>($"/api/media/{name}/meta");
            Assert.False(meta.GetProperty("thumb").GetBoolean());
            Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/api/media/{name}/thumb?w=320")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task WithAConverter_HeicGetsItsSizeAndThumbnails()
    {
        var work = Path.Combine(Path.GetTempPath(), "papyra-heif-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var picture = Path.Combine(work, "converted.png");
        using (var bitmap = new SKBitmap(400, 300))
        {
            bitmap.Erase(SKColors.SeaGreen);
            using var data = SKImage.FromBitmap(bitmap).Encode(SKEncodedImageFormat.Png, 90);
            await File.WriteAllBytesAsync(picture, data.ToArray());
        }
        var converter = FakeConverter(work, picture);
        var (factory, dir) = NewApp(converter);
        try
        {
            var owner = await OwnerAsync(factory);
            var name = await UploadAsync(owner, Heic, "IMG_0002.heic");
            var meta = await owner.GetFromJsonAsync<JsonElement>($"/api/media/{name}/meta");
            Assert.True(meta.GetProperty("thumb").GetBoolean());

            var thumb = await owner.GetAsync($"/api/media/{name}/thumb?w=160");
            Assert.Equal(HttpStatusCode.OK, thumb.StatusCode);
            Assert.Equal("image/webp", thumb.Content.Headers.ContentType?.MediaType);

            // Measured through the rendition once it exists.
            meta = await owner.GetFromJsonAsync<JsonElement>($"/api/media/{name}/meta");
            Assert.Equal(400, meta.GetProperty("width").GetInt32());
            Assert.Equal(300, meta.GetProperty("height").GetInt32());
        }
        finally
        {
            Cleanup(factory, dir);
            try { Directory.Delete(work, recursive: true); } catch (IOException) { }
        }
    }

    // A script with heif-convert's calling convention (`-q 90 <in> <out>`) that
    // writes a known picture to <out>.
    private static string FakeConverter(string dir, string picture)
    {
        if (OperatingSystem.IsWindows())
        {
            var cmd = Path.Combine(dir, "heif-convert.cmd");
            File.WriteAllText(cmd, $"@copy /y \"{picture}\" \"%~4\" >nul\r\n");
            return cmd;
        }
        var sh = Path.Combine(dir, "heif-convert");
        File.WriteAllText(sh, $"#!/bin/sh\ncp \"{picture}\" \"$4\"\n");
        File.SetUnixFileMode(sh, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return sh;
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(string? converter)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-heic-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            if (converter is not null) b.UseSetting("Media:HeifConvert", converter);
        });
        return (factory, dir);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    private static async Task<HttpClient> OwnerAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostSetupAsync(new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw))).StatusCode);
        return client;
    }

    private static async Task<string> UploadAsync(HttpClient client, byte[] bytes, string name)
    {
        using var form = new MultipartFormDataContent { { new ByteArrayContent(bytes), "file", name } };
        var res = await client.PostAsync("/api/media/upload", form);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("filename").GetString()!;
    }
}
