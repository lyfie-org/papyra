using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.FileProviders;
using Papyra.Api.Security;

namespace Papyra.Api.Features;

public sealed partial class AppShell(IFileProvider webRoot, AppBase appBase)
{
    [GeneratedRegex("""(?<attr>\b(?:href|src)=")(?:\.(?=/))?/(?!/)""")]
    private static partial Regex RootRelative();

    [GeneratedRegex("""<meta\s+charset="[^"]*"\s*/?>""", RegexOptions.IgnoreCase)]
    private static partial Regex Charset();

    private readonly object gate = new();
    private (DateTimeOffset Stamp, long Length, byte[] Body)? index;
    private (DateTimeOffset Stamp, long Length, byte[] Body)? manifest;

    public static string Rewrite(string html, AppBase appBase)
    {
        var rewritten = RootRelative().Replace(html, m => m.Groups["attr"].Value + appBase.Path + "/");
        if (appBase.IsRoot) return rewritten;
        var meta = $"<meta name=\"papyra-base\" content=\"{appBase.Path}\" />";
        var charset = Charset().Match(rewritten);
        return charset.Success
            ? rewritten.Insert(charset.Index + charset.Length, "\n    " + meta)
            : rewritten;
    }

    public static string RewriteManifest(string json, AppBase appBase)
    {
        if (appBase.IsRoot) return json;
        var node = JsonNode.Parse(json);
        Prefix(node, appBase.Path);
        return node?.ToJsonString() ?? json;
    }

    private static readonly HashSet<string> UrlKeys = new(StringComparer.Ordinal) { "id", "start_url", "scope", "src", "url" };

    private static void Prefix(JsonNode? node, string basePath)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(p => p.Key).ToList())
                {
                    if (UrlKeys.Contains(key) && obj[key] is JsonValue v && v.TryGetValue<string>(out var s)
                        && s.StartsWith('/') && !s.StartsWith("//"))
                        obj[key] = basePath + s;
                    else
                        Prefix(obj[key], basePath);
                }
                break;
            case JsonArray arr:
                foreach (var item in arr) Prefix(item, basePath);
                break;
        }
    }

    private byte[]? Load(string name, ref (DateTimeOffset Stamp, long Length, byte[] Body)? cache, Func<string, string> transform)
    {
        var file = webRoot.GetFileInfo(name);
        if (!file.Exists || file.IsDirectory) return null;
        lock (gate)
        {
            if (cache is { } hit && hit.Stamp == file.LastModified && hit.Length == file.Length) return hit.Body;
            using var stream = file.CreateReadStream();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var body = Encoding.UTF8.GetBytes(transform(reader.ReadToEnd()));
            cache = (file.LastModified, file.Length, body);
            return body;
        }
    }

    public Task<bool> ServeIndexAsync(HttpContext http) =>
        WriteAsync(http, Load("index.html", ref index, html => Rewrite(html, appBase)), "text/html; charset=utf-8");

    public Task<bool> ServeManifestAsync(HttpContext http) =>
        WriteAsync(http, Load("site.webmanifest", ref manifest, json => RewriteManifest(json, appBase)), "application/manifest+json");

    private static async Task<bool> WriteAsync(HttpContext http, byte[]? body, string contentType)
    {
        if (body is null) return false;
        http.Response.StatusCode = StatusCodes.Status200OK;
        http.Response.ContentType = contentType;
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.ContentLength = body.Length;
        if (!HttpMethods.IsHead(http.Request.Method))
            await http.Response.Body.WriteAsync(body, http.RequestAborted);
        return true;
    }

    public Task<bool> TryServeIndexAsync(HttpContext http) =>
        HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method)
            ? ServeIndexAsync(http)
            : Task.FromResult(false);

    public async Task<bool> TryServeAsync(HttpContext http)
    {
        if (!HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method)) return false;
        var path = http.Request.Path.Value;
        if (path == "/index.html") return await ServeIndexAsync(http);
        if (!appBase.IsRoot && path == "/site.webmanifest") return await ServeManifestAsync(http);
        return false;
    }
}
