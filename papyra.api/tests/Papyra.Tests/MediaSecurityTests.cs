using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Attachments are served from Papyra's own origin, so what an upload is, how it
/// is served, and who may fetch it are security boundaries. Before this suite an
/// uploaded page ran as the app (stored XSS), any share link served every file
/// the owner had, and a locked note's pictures skipped the vault PIN.
/// </summary>
public sealed class MediaSecurityTests
{
    private const string Pw = "hunter2!";

    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    // ── Sniffing ──────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("89504E470D0A1A0A0000000D49484452", "x.jpg", "image", ".png")]
    [InlineData("FFD8FFE000104A464946", "photo.png", "image", ".jpg")]
    [InlineData("474946383961010001", "a.gif", "gif", ".gif")]
    [InlineData("52494646000000005745425056503820", "a.webp", "image", ".webp")]
    [InlineData("000000186674797069736F6D0000020069736F6D", "clip.mp4", "video", ".mp4")]
    [InlineData("000000186674797069736F6D0000020069736F6D", "clip.m4v", "video", ".m4v")]
    [InlineData("0000001466747970717420200000000071742020", "clip.mp4", "video", ".mov")]
    [InlineData("00000018667479706865696300000000", "IMG_1.HEIC", "image", ".heic")]
    [InlineData("000000206674797061766966000000006D696631", "a.avif", "image", ".avif")]
    [InlineData("1A45DFA3A34286810142F7810142F2810442F381084282847765626D", "v.webm", "video", ".webm")]
    [InlineData("4F67675300020000000000000000", "a.ogg", "audio", ".ogg")]
    [InlineData("494433030000000000", "song.mp3", "audio", ".mp3")]
    [InlineData("664C614300000022", "a.flac", "audio", ".flac")]
    [InlineData("255044462D312E370A", "report.pdf", "document", ".pdf")]
    [InlineData("504B0304140006000800", "letter.docx", "document", ".docx")]
    [InlineData("504B0304140006000800", "evil.html", "document", ".zip")]
    [InlineData("D0CF11E0A1B11AE10000", "old.xls", "document", ".xls")]
    [InlineData("D0CF11E0A1B11AE10000", "old.exe", "file", ".bin")]
    [InlineData("4D5A90000300000004000000", "setup.png", "file", ".bin")]
    public void Sniff_TrustsTheBytes_NotTheName(string hex, string name, string kind, string ext)
    {
        var sniffed = MediaSniffer.Sniff(Convert.FromHexString(hex), name);
        Assert.Equal(kind, sniffed.Kind);
        Assert.Equal(ext, sniffed.Extension);
    }

    [Theory]
    [InlineData("<html><script>alert(1)</script></html>", "photo.png", ".txt")]
    [InlineData("<!doctype html><body onload=x()>", "page.html", ".txt")]
    [InlineData("alert(document.cookie)", "app.js", ".txt")]
    [InlineData("# heading\nsome notes", "notes.md", ".md")]
    [InlineData("a,b\n1,2", "data.csv", ".csv")]
    [InlineData("<?xml version=\"1.0\"?>\n<!-- c --><svg xmlns=\"http://www.w3.org/2000/svg\"><script>x</script></svg>", "logo.png", ".svg")]
    [InlineData("﻿  <svg viewBox=\"0 0 1 1\"/>", "i.svg", ".svg")]
    [InlineData("<svgfoo/>", "i.svg", ".txt")]
    public void Sniff_MarkupIsStoredAsInertText_OrSvg(string content, string name, string ext) =>
        Assert.Equal(ext, MediaSniffer.Sniff(Encoding.UTF8.GetBytes(content), name).Extension);

    [Fact]
    public void Sniff_Polyglot_IsStoredAsWhatItStartsAs()
    {
        // A GIF header followed by script: stored and served as image/gif with
        // nosniff, so a browser renders (or fails to render) a picture.
        var sniffed = MediaSniffer.Sniff(Encoding.ASCII.GetBytes("GIF89a<script>alert(1)</script>"), "x.html");
        Assert.Equal(".gif", sniffed.Extension);
    }

    [Fact]
    public void Sniff_TruncatedOrEmpty_IsOpaque()
    {
        Assert.Equal(".bin", MediaSniffer.Sniff([], "a.png").Extension);
        Assert.Equal(".bin", MediaSniffer.Sniff([0x89, 0x50, 0x4E, 0x47], "a.png").Extension);
        Assert.Equal(".bin", MediaSniffer.Sniff([0x00, 0x01, 0x02, 0xFE, 0xFF], "a.txt").Extension);
    }

    [Fact]
    public void Sniff_TextCutMidCharacter_IsStillText()
    {
        var bytes = Encoding.UTF8.GetBytes("naïve café ✓");
        Assert.Equal(".txt", MediaSniffer.Sniff(bytes.AsSpan(0, bytes.Length - 1), "a.txt").Extension);
    }

    [Fact]
    public void Limits_FollowTheSniffedKind()
    {
        Assert.Equal(MediaLimits.Image, MediaLimits.ForKind("image").Limit);
        Assert.Equal(MediaLimits.Video, MediaLimits.ForKind("video").Limit);
        Assert.Equal(MediaLimits.Other, MediaLimits.ForKind("file").Limit);
        Assert.Equal(MediaLimits.Other, MediaLimits.ForKind("anything-else").Limit);
    }

    // ── Reference parsing ─────────────────────────────────────────────────────

    [Fact]
    public void RefParser_FindsEveryEmbedForm()
    {
        var refs = MediaRefParser.Extract(string.Join('\n',
            "![[photo-1a2b3c.png]]",
            "![[Sized.PNG|480]] and ![[clip.mp4|640x360]]",
            "![[doc.pdf#page=3]] [[plain.pdf]]",
            "![alt](/api/media/linked%20name.jpg) ![](attachments/rel.gif \"t\")",
            "![](<spaced name.png>)",
            "<img src=\"/api/media/html.webp\"> <video poster='poster.jpg'></video>",
            "bare /api/media/bare.mp3 url",
            "![[youtube:https://youtu.be/x|cap]] ![](https://example.com/remote.png) [site](/notes/abc)"));

        foreach (var name in new[] { "photo-1a2b3c.png", "sized.png", "clip.mp4", "doc.pdf", "plain.pdf",
                     "linked name.jpg", "rel.gif", "spaced name.png", "html.webp", "poster.jpg", "bare.mp3" })
            Assert.Contains(name, refs);
        Assert.DoesNotContain("remote.png", refs);
        Assert.DoesNotContain(refs, r => r.Contains("youtu", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain("abc", refs);
    }

    // ── Serving ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task UploadedPage_RenamedPng_IsStoredAndServedAsInertText()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var name = await UploadAsync(owner, Encoding.UTF8.GetBytes("<html><script>alert(1)</script></html>"), "photo.png");
            Assert.EndsWith(".txt", name);

            var res = await owner.GetAsync($"/api/media/{name}");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("text/plain", res.Content.Headers.ContentType?.MediaType);
            AssertSandboxed(res);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LegacyActiveContent_OnDisk_IsAnOpaqueDownload()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            // Written before uploads were sniffed.
            var media = Path.Combine(dir, "users", "1", "media");
            Directory.CreateDirectory(media);
            foreach (var legacy in new[] { "old.html", "old.js", "old.xhtml", "old.xml" })
            {
                await File.WriteAllTextAsync(Path.Combine(media, legacy), "<script>alert(1)</script>");
                var res = await owner.GetAsync($"/api/media/{legacy}");
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                Assert.Equal("application/octet-stream", res.Content.Headers.ContentType?.MediaType);
                Assert.Equal("attachment", res.Content.Headers.ContentDisposition?.DispositionType);
                AssertSandboxed(res);
            }

            // SVG renders (inside <img> it is inert) but is sandboxed if opened directly.
            await File.WriteAllTextAsync(Path.Combine(media, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
            var svg = await owner.GetAsync("/api/media/logo.svg");
            Assert.Equal("image/svg+xml", svg.Content.Headers.ContentType?.MediaType);
            Assert.Null(svg.Content.Headers.ContentDisposition);
            AssertSandboxed(svg);

            // Documents download, typed for the OS.
            await File.WriteAllBytesAsync(Path.Combine(media, "memo.docx"), [0x50, 0x4B, 0x03, 0x04]);
            var docx = await owner.GetAsync("/api/media/memo.docx");
            Assert.Equal("attachment", docx.Content.Headers.ContentDisposition?.DispositionType);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Images_AreInline_Cacheable_Revalidatable_AndRangeable()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var name = await UploadAsync(owner, Png, "shot.jpeg");
            Assert.EndsWith(".png", name);

            var res = await owner.GetAsync($"/api/media/{name}");
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("image/png", res.Content.Headers.ContentType?.MediaType);
            Assert.Null(res.Content.Headers.ContentDisposition);
            Assert.True(res.Headers.CacheControl?.Private);
            Assert.Contains("nosniff", res.Headers.GetValues("X-Content-Type-Options"));
            var etag = res.Headers.ETag;
            Assert.NotNull(etag);

            var again = new HttpRequestMessage(HttpMethod.Get, $"/api/media/{name}");
            again.Headers.IfNoneMatch.Add(etag!);
            Assert.Equal(HttpStatusCode.NotModified, (await owner.SendAsync(again)).StatusCode);

            var range = new HttpRequestMessage(HttpMethod.Get, $"/api/media/{name}");
            range.Headers.Range = new RangeHeaderValue(0, 7);
            var partial = await owner.SendAsync(range);
            Assert.Equal(HttpStatusCode.PartialContent, partial.StatusCode);
            Assert.Equal(8, (await partial.Content.ReadAsByteArrayAsync()).Length);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Pdf_KeepsTheAppPolicy_SoTheBrowserViewerWorks()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var name = await UploadAsync(owner, Encoding.ASCII.GetBytes("%PDF-1.7\n%%EOF"), "a.pdf");
            var res = await owner.GetAsync($"/api/media/{name}");
            Assert.Equal("application/pdf", res.Content.Headers.ContentType?.MediaType);
            Assert.DoesNotContain("sandbox", string.Join(";", res.Headers.GetValues("Content-Security-Policy")));
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Share scoping ─────────────────────────────────────────────────────────

    [Fact]
    public async Task LinkShare_ServesOnlyTheSharedNotesOwnMedia()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var shared = await UploadAsync(owner, Png, "shared.png");
            var other = await UploadAsync(owner, Png, "private.png");
            await WriteNoteAsync(owner, "n1", $"look ![[{shared}|300]]");
            await WriteNoteAsync(owner, "n2", $"mine ![[{other}]]");
            var token = await LinkAsync(owner, "n1", maxViews: null);

            var anon = factory.CreateClient();
            var ok = await anon.GetAsync($"/api/shared/{token}/media/{shared}");
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            Assert.True(ok.Headers.CacheControl?.NoCache);
            Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/shared/{token}/media/{other}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/shared/{token}/media/..%2F..%2Fapp.db")).StatusCode);

            // Locked after sharing: its pictures go back into the vault with it.
            await owner.PutAsJsonAsync("/api/notes/n1", new NoteWrite("N", null, null, false, false,
                $"look ![[{shared}|300]]", Kind: null, Secure: true));
            Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/shared/{token}/media/{shared}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LinkShare_Expired_OrSpent_ServesNoMedia_ExceptToTheCountedLoad()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var pic = await UploadAsync(owner, Png, "p.png");
            await WriteNoteAsync(owner, "n1", $"![[{pic}]]");

            var expired = await LinkAsync(owner, "n1", maxViews: null, expires: DateTime.UtcNow.AddMinutes(-1));
            Assert.Equal(HttpStatusCode.Gone, (await factory.CreateClient().GetAsync($"/api/shared/{expired}/media/{pic}")).StatusCode);

            var once = await LinkAsync(owner, "n1", maxViews: 1);
            var reader = factory.CreateClient();
            var load = new HttpRequestMessage(HttpMethod.Get, $"/api/shared/{once}");
            load.Headers.Add("X-Papyra-View", "load-1");
            Assert.Equal(HttpStatusCode.OK, (await reader.SendAsync(load)).StatusCode);
            // The page that spent the view still gets its pictures…
            Assert.Equal(HttpStatusCode.OK, (await reader.GetAsync($"/api/shared/{once}/media/{pic}")).StatusCode);
            // …nobody else does.
            Assert.Equal(HttpStatusCode.Gone, (await factory.CreateClient().GetAsync($"/api/shared/{once}/media/{pic}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task IncomingShare_ServesOnlyThatNotesMedia()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            var shared = await UploadAsync(owner, Png, "s.png");
            var other = await UploadAsync(owner, Png, "o.png");
            await WriteNoteAsync(owner, "n1", $"![[{shared}]]");
            await WriteNoteAsync(owner, "n2", $"![[{other}]]");
            var res = await owner.PostAsJsonAsync("/api/notes/n1/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null));
            var shareId = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

            Assert.Equal(HttpStatusCode.OK, (await bea.GetAsync($"/api/shares/incoming/{shareId}/media/{shared}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/shares/incoming/{shareId}/media/{other}")).StatusCode);
            // Bea's own /api/media is her own vault, never the owner's.
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/media/{shared}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Vault gate ────────────────────────────────────────────────────────────

    [Fact]
    public async Task LockedNotesMedia_NeedsAnOpenVault()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var scan = await UploadAsync(owner, Png, "passport.png");
            var shared = await UploadAsync(owner, Png, "both.png");
            await WriteNoteAsync(owner, "s1", $"![[{scan}]] ![[{shared}]]", secure: true);
            await WriteNoteAsync(owner, "n1", $"also here ![[{shared}]]");

            // A fresh session of the same account with no unlock.
            var session = factory.CreateClient();
            Assert.Equal(HttpStatusCode.OK, (await session.LoginAsync("owner", Pw)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await session.GetAsync($"/api/media/{scan}")).StatusCode);
            // Also in an ordinary note: not a vault secret.
            Assert.Equal(HttpStatusCode.OK, (await session.GetAsync($"/api/media/{shared}")).StatusCode);

            // Header unlock.
            var token = await UnlockAsync(session);
            var withHeader = new HttpRequestMessage(HttpMethod.Get, $"/api/media/{scan}");
            withHeader.Headers.Add("X-Unlock-Token", token);
            var opened = await session.SendAsync(withHeader);
            Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
            Assert.True(opened.Headers.CacheControl?.NoCache);
            // The unlock also set the media cookie (what an <img> uses).
            Assert.Equal(HttpStatusCode.OK, (await session.GetAsync($"/api/media/{scan}")).StatusCode);

            // Locking again closes it.
            await session.PostAsync("/api/auth/vault/lock", null);
            Assert.Equal(HttpStatusCode.Unauthorized, (await session.GetAsync($"/api/media/{scan}")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Upload hygiene ────────────────────────────────────────────────────────

    [Fact]
    public void Prune_RemovesStaleUploadTemps_ButNotOnesInFlight()
    {
        var dataDir = Path.Combine(Path.GetTempPath(), "papyra-tmp-" + Guid.NewGuid().ToString("N"));
        var media = Path.Combine(dataDir, "users", "1", "media");
        Directory.CreateDirectory(media);
        try
        {
            var stale = Path.Combine(media, "aaa.tmp");
            var fresh = Path.Combine(media, "bbb.tmp");
            File.WriteAllText(stale, "x");
            File.WriteAllText(fresh, "y");
            File.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddHours(-2));

            var state = new VaultState();
            state.Upsert("1", Path.Combine(dataDir, "users", "1", "notes", "n.md"), new Note { Id = "n", Body = "" });
            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = dataDir }).Build();
            var moved = new OrphanPruneService(state, config, new StubEnv(),
                new JobRegistry(NullLogger<JobRegistry>.Instance), NullLogger<OrphanPruneService>.Instance).PruneOnce();

            Assert.Equal(0, moved);
            Assert.False(File.Exists(stale));
            Assert.True(File.Exists(fresh));
        }
        finally { Directory.Delete(dataDir, recursive: true); }
    }

    [Fact]
    public async Task Import_AcceptsBodiesAboveKestrelsDefaultLimit()
    {
        var (factory, dir) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            // 32 MB — over the ~28.6 MB default that used to refuse every real vault.
            using var form = new MultipartFormDataContent
            {
                { new ByteArrayContent(new byte[32 * 1024 * 1024]), "file", "vault.zip" },
            };
            var res = await owner.PostAsync("/api/import/obsidian", form);
            Assert.NotEqual(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static void AssertSandboxed(HttpResponseMessage res)
    {
        var csp = string.Join(";", res.Headers.GetValues("Content-Security-Policy"));
        Assert.StartsWith("sandbox", csp);
        Assert.Contains("default-src 'none'", csp);
        Assert.DoesNotContain("script-src", csp);
        Assert.Contains("nosniff", res.Headers.GetValues("X-Content-Type-Options"));
    }

    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-media-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
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
        await TestAuth.SetVaultPinAsync(client, Pw);
        return client;
    }

    private static async Task<HttpClient> MemberAsync(WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"))).StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
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

    private static async Task<string> LinkAsync(HttpClient owner, string noteId, int? maxViews, DateTime? expires = null)
    {
        var res = await owner.PostAsJsonAsync($"/api/notes/{noteId}/shares", new ShareWrite(
            Kind: "link", Access: "view", GranteeUsername: null, ExpiresUtc: expires, MaxViews: maxViews));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;
    }

    private static async Task<string> UnlockAsync(HttpClient client)
    {
        var res = await client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("unlockToken").GetString()!;
    }

    private sealed class StubEnv : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "Papyra.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
