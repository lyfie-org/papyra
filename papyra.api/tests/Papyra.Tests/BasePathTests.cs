using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Papyra.Api.Features;
using Papyra.Api.Security;

namespace Papyra.Tests;

public sealed class BasePathTests
{
    private const string Shell = """
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <link rel="icon" type="image/x-icon" href="./favicon.ico" />
            <link rel="manifest" href="./site.webmanifest" />
            <link rel="stylesheet" href="./fonts/fonts.css" />
            <script type="module" crossorigin src="./assets/index-abc.js"></script>
            <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
          </head>
          <body>
            <script>var theme = location.pathname;</script>
            <div id="root"></div>
            <a href="//cdn.example/x">x</a>
          </body>
        </html>
        """;

    private const string Manifest = """
        {"name":"Papyra","id":"/","start_url":"/","scope":"/","display":"standalone",
         "icons":[{"src":"/android-chrome-192x192.png","sizes":"192x192"}]}
        """;

    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("/", "")]
    [InlineData("  ", "")]
    [InlineData("papyra", "/papyra")]
    [InlineData("/papyra", "/papyra")]
    [InlineData("/papyra/", "/papyra")]
    [InlineData("/apps/papyra//", "/apps/papyra")]
    [InlineData("/my-notes_1.0", "/my-notes_1.0")]
    public void NormalizeAcceptsPathsInEitherSpelling(string? raw, string expected)
        => Assert.Equal(expected, AppBase.Normalize(raw));

    [Theory]
    [InlineData("/a b")]
    [InlineData("/..")]
    [InlineData("/a/../b")]
    [InlineData("/a?x=1")]
    [InlineData("//evil.example")]
    [InlineData("https://example.com/papyra")]
    [InlineData("/a\\b")]
    public void NormalizeRefusesAnythingThatIsNotAPlainPath(string raw)
        => Assert.Throws<InvalidOperationException>(() => AppBase.Normalize(raw));

    [Fact]
    public void RootShellKeepsTodaysAbsoluteUrls()
    {
        var html = AppShell.Rewrite(Shell, AppBase.Root);

        Assert.Contains("href=\"/favicon.ico\"", html);
        Assert.Contains("src=\"/assets/index-abc.js\"", html);
        Assert.Contains("href=\"/fonts/fonts.css\"", html);
        Assert.DoesNotContain("papyra-base", html);
        Assert.DoesNotContain("=\"./", html);
    }

    [Fact]
    public void PrefixedShellPointsEveryAssetUnderTheBase()
    {
        var html = AppShell.Rewrite(Shell, AppBase.From("/papyra"));

        Assert.Contains("href=\"/papyra/favicon.ico\"", html);
        Assert.Contains("href=\"/papyra/site.webmanifest\"", html);
        Assert.Contains("src=\"/papyra/assets/index-abc.js\"", html);
        Assert.Contains("href=\"/papyra/assets/index-abc.css\"", html);
        Assert.Contains("<meta name=\"papyra-base\" content=\"/papyra\" />", html);
        Assert.Contains("href=\"//cdn.example/x\"", html);
    }

    [Fact]
    public void AnOlderBuildWithRootUrlsIsPrefixedToo()
    {
        var html = AppShell.Rewrite("<meta charset=\"UTF-8\" /><script src=\"/assets/a.js\"></script>", AppBase.From("/p"));

        Assert.Contains("src=\"/p/assets/a.js\"", html);
    }

    [Fact]
    public void TheInlineScriptIsNeverTouchedSoItsCspHashStillMatches()
    {
        var before = Papyra.Api.Security.SecurityHeaders.InlineScriptHashes(Shell);
        var after = Papyra.Api.Security.SecurityHeaders.InlineScriptHashes(AppShell.Rewrite(Shell, AppBase.From("/papyra")));

        Assert.Equal(before, after);
    }

    [Fact]
    public void ManifestUrlsMoveUnderTheBase()
    {
        var json = JsonDocument.Parse(AppShell.RewriteManifest(Manifest, AppBase.From("/papyra"))).RootElement;

        Assert.Equal("/papyra/", json.GetProperty("id").GetString());
        Assert.Equal("/papyra/", json.GetProperty("start_url").GetString());
        Assert.Equal("/papyra/", json.GetProperty("scope").GetString());
        Assert.Equal("/papyra/android-chrome-192x192.png", json.GetProperty("icons")[0].GetProperty("src").GetString());
        Assert.Equal("Papyra", json.GetProperty("name").GetString());
    }

    [Fact]
    public void ManifestIsUntouchedAtTheRoot()
        => Assert.Equal(Manifest, AppShell.RewriteManifest(Manifest, AppBase.Root));

    [Fact]
    public void UnlockCookieIsScopedUnderTheBase()
    {
        foreach (var (basePath, expected) in new[] { ("", "path=/api/media"), ("/papyra", "path=/papyra/api/media") })
        {
            var services = new ServiceCollection().AddSingleton(AppBase.From(basePath)).BuildServiceProvider();
            var http = new DefaultHttpContext { RequestServices = services };

            UnlockCookie.Set(http, "token");

            Assert.Contains(expected, http.Response.Headers.SetCookie.ToString(), StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void PublicOriginCarriesTheBase()
    {
        var services = new ServiceCollection().AddSingleton(AppBase.From("/papyra")).BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Request.Scheme = "https";
        http.Request.Host = new HostString("notes.example.com");

        Assert.Equal("https://notes.example.com/papyra", http.PublicOrigin());
    }

    [Theory]
    [InlineData("/papyra")]
    [InlineData("")]
    public async Task ServedShellAndManifestFollowTheConfiguredBase(string basePath)
    {
        var data = Path.Combine(Path.GetTempPath(), "papyra-base-" + Guid.NewGuid().ToString("N"));
        var web = Path.Combine(data, "web");
        Directory.CreateDirectory(web);
        File.WriteAllText(Path.Combine(web, "index.html"), Shell);
        File.WriteAllText(Path.Combine(web, "site.webmanifest"), Manifest);
        File.WriteAllText(Path.Combine(web, "version.json"), "{\"version\":\"t\"}");

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", Path.Combine(data, "vault"));
            b.UseSetting("Papyra:BasePath", basePath);
            b.UseSetting("Features:Collab", "false");
            b.UseSetting("Features:UpdateCheck", "false");
            b.ConfigureTestServices(s => s.AddSingleton(new AppShell(new PhysicalFileProvider(web), AppBase.From(basePath))));
        });

        try
        {
            var client = factory.CreateClient();
            var prefix = basePath;

            foreach (var url in new[] { "/", "/notes/3", "/index.html" })
            {
                var shell = await client.GetStringAsync(url);
                Assert.Contains($"src=\"{prefix}/assets/index-abc.js\"", shell);
                Assert.Contains($"href=\"{prefix}/fonts/fonts.css\"", shell);
                Assert.Equal(prefix.Length > 0, shell.Contains("papyra-base"));
            }

            if (prefix.Length > 0)
            {
                foreach (var url in new[] { $"{prefix}/", $"{prefix}/notes/3", $"{prefix}/settings?tab=general" })
                {
                    var shell = await client.GetStringAsync(url);
                    Assert.Contains($"src=\"{prefix}/assets/index-abc.js\"", shell);
                }

                var manifest = await client.GetFromJsonAsync<JsonElement>($"{prefix}/site.webmanifest");
                Assert.Equal($"{prefix}/", manifest.GetProperty("start_url").GetString());
                var bare = await client.GetFromJsonAsync<JsonElement>("/site.webmanifest");
                Assert.Equal($"{prefix}/", bare.GetProperty("scope").GetString());
            }
            else
            {
                var manifest = await client.GetFromJsonAsync<JsonElement>("/site.webmanifest");
                Assert.Equal("/", manifest.GetProperty("start_url").GetString());
            }

            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"{prefix}/health")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);

            var missing = await client.GetAsync($"{prefix}/api/auth/nothing-here");
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
            Assert.Equal("application/json", missing.Content.Headers.ContentType?.MediaType);

            var post = await client.PostAsync($"{prefix}/notes/3", new StringContent(""));
            Assert.Equal(HttpStatusCode.NotFound, post.StatusCode);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(data, recursive: true); } catch (IOException) { }
        }
    }
}
