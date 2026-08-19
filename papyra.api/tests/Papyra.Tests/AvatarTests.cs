using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// Profile pictures are the one place a user hands the server a file that it
/// later serves back from its own origin. What goes in has to be an image, and
/// what comes out has to be labelled as the format it actually is.
/// </summary>
public sealed class AvatarTests
{
    private const string Pw = "hunter2!";

    // Smallest valid files of each kind: enough for the magic-byte check, which
    // is all the endpoint claims to do.
    private static byte[] Png() =>
    [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        .. "not really the rest of a png"u8.ToArray(),
    ];
    private static byte[] Jpeg() => [0xFF, 0xD8, 0xFF, .. "jfif-ish"u8.ToArray()];
    private static byte[] Svg() => "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"u8.ToArray();

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-avatar-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        return (factory, dir);
    }

    private static async Task<HttpClient> OwnerAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var setup = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        return client;
    }

    private static Task<HttpResponseMessage> UploadAsync(
        HttpClient client, byte[] bytes, string filename, string contentType)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        var form = new MultipartFormDataContent { { content, "file", filename } };
        return client.PostAsync("/api/auth/avatar", form);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    [Fact]
    public async Task APngIsStoredAndServedAsAPng()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            Assert.Equal(HttpStatusCode.OK, (await UploadAsync(owner, Png(), "me.png", "image/png")).StatusCode);

            var read = await owner.GetAsync("/api/auth/avatar");
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
            Assert.Equal("image/png", read.Content.Headers.ContentType?.MediaType);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task AnSvgIsRefusedHoweverItIsLabelled()
    {
        // The one that mattered: an SVG carries script, and the old endpoint took
        // the extension from the filename and served it back from this origin.
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);

            Assert.Equal(HttpStatusCode.BadRequest,
                (await UploadAsync(owner, Svg(), "me.svg", "image/svg+xml")).StatusCode);
            // Lying about the name or the content type changes nothing — the
            // decision is made from the bytes.
            Assert.Equal(HttpStatusCode.BadRequest,
                (await UploadAsync(owner, Svg(), "me.png", "image/png")).StatusCode);

            Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/api/auth/avatar")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TheExtensionOnTheUploadDecidesNothing()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            // Real JPEG bytes, mislabelled as .html. Stored as .jpg, served as
            // image/jpeg — never as the thing the caller named it.
            Assert.Equal(HttpStatusCode.OK,
                (await UploadAsync(owner, Jpeg(), "me.html", "text/html")).StatusCode);

            var read = await owner.GetAsync("/api/auth/avatar");
            Assert.Equal("image/jpeg", read.Content.Headers.ContentType?.MediaType);

            var stored = Directory.EnumerateFiles(dir, "avatar.*", SearchOption.AllDirectories);
            Assert.Equal(".jpg", Path.GetExtension(Assert.Single(stored)));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OnlyOneAvatarSurvivesAnUpload()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await UploadAsync(owner, Png(), "first.png", "image/png");
            await UploadAsync(owner, Jpeg(), "second.jpg", "image/jpeg");

            // One file, whatever it is called — the second upload replaces the
            // first rather than sitting beside it under a different extension.
            Assert.Single(Directory.EnumerateFiles(dir, "avatar.*", SearchOption.AllDirectories));
            Assert.Equal("image/jpeg",
                (await owner.GetAsync("/api/auth/avatar")).Content.Headers.ContentType?.MediaType);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task OneUserCanSeeAnothersPictureButNotTheirAbsenceOfOne()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await UploadAsync(owner, Png(), "me.png", "image/png");

            var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: "bea", Name: "Bea", Email: "b@b.c", Password: Pw, Role: "User"));
            Assert.Equal(HttpStatusCode.OK, provision.StatusCode);

            var bea = factory.CreateClient();
            await bea.PostAsJsonAsync("/api/auth/login", new LoginRequest("bea", Pw));
            await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);

            var seen = await bea.GetAsync("/api/auth/avatar/owner");
            Assert.Equal(HttpStatusCode.OK, seen.StatusCode);
            Assert.Equal("image/png", seen.Content.Headers.ContentType?.MediaType);

            // Bea has no picture, and neither does a name that isn't anyone —
            // the same answer, so this is not a way to enumerate accounts.
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync("/api/auth/avatar/bea")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync("/api/auth/avatar/nobody")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task ASignedOutVisitorSeesNobodysPicture()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await UploadAsync(owner, Png(), "me.png", "image/png");

            var anonymous = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/auth/avatar")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/auth/avatar/owner")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
