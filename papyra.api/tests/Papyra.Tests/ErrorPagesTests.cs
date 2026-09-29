using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Papyra.Api.Security;

namespace Papyra.Tests;

// What a person sees when the server fails them: a reference to quote and a
// short trace to send the admin — as JSON for the SPA, as a page for a browser
// navigation (the SSO callback used to end on Chrome's bare "HTTP ERROR 500").
public sealed class ErrorPagesTests
{
    private static Exception Thrown()
    {
        try { throw new InvalidOperationException("outer", new FormatException("inner cause")); }
        catch (Exception ex) { return ex; }
    }

    private static async Task<(DefaultHttpContext Http, string Body)> Render(string path, string? accept, bool details = true)
    {
        var http = new DefaultHttpContext();
        http.Request.Method = "GET";
        http.Request.Path = path;
        if (accept is not null) http.Request.Headers.Accept = accept;
        http.Response.Body = new MemoryStream();
        await ErrorPages.WriteAsync(http, ErrorPages.For(http, Thrown(), "ABCD-EFGH", details, "1.2.3"));
        http.Response.Body.Position = 0;
        return (http, await new StreamReader(http.Response.Body).ReadToEndAsync());
    }

    [Fact]
    public async Task ApiCalls_GetJsonWithTheReferenceAndTrace()
    {
        var (http, body) = await Render("/api/notes", "text/html,*/*");
        Assert.Equal(500, http.Response.StatusCode);
        var json = JsonDocument.Parse(body).RootElement;
        Assert.Equal("ABCD-EFGH", json.GetProperty("errorId").GetString());
        Assert.Equal("server_error", json.GetProperty("code").GetString());
        var stack = json.GetProperty("detail").GetProperty("stack").GetString()!;
        Assert.Contains("System.InvalidOperationException: outer", stack);
        Assert.Contains("---> System.FormatException: inner cause", stack);
        Assert.Equal("1.2.3", json.GetProperty("detail").GetProperty("version").GetString());
    }

    [Fact]
    public async Task BrowserNavigations_GetAPapyraPage_WithItsOwnLockedDownCsp()
    {
        var (http, body) = await Render("/signin-oidc/acme", "text/html,application/xhtml+xml");
        Assert.StartsWith("text/html", http.Response.ContentType);
        Assert.Contains("Reference ABCD-EFGH", body);
        Assert.Contains("Copy error details", body);
        Assert.Contains("inner cause", body);
        var csp = http.Response.Headers.ContentSecurityPolicy.ToString();
        Assert.Contains("default-src 'none'", csp);
        Assert.Contains("script-src 'nonce-", csp);
    }

    [Fact]
    public async Task DetailsCanBeTurnedOff_LeavingOnlyTheReference()
    {
        var (_, body) = await Render("/api/notes", null, details: false);
        var json = JsonDocument.Parse(body).RootElement;
        Assert.Equal("ABCD-EFGH", json.GetProperty("errorId").GetString());
        Assert.Equal(JsonValueKind.Null, json.GetProperty("detail").ValueKind);
        Assert.DoesNotContain("inner cause", body);
    }

    [Fact]
    public void Traces_NameFilesNotMachinePaths()
    {
        var stack = ErrorPages.TrimStack(Thrown());
        Assert.DoesNotMatch(@"[A-Za-z]:\|/home/|/src/", stack);
        Assert.Contains("ErrorPagesTests.cs:line", stack);
    }

    [Fact]
    public void ErrorIds_AreShortAndUnambiguous()
    {
        var id = ErrorPages.NewErrorId();
        Assert.Matches("^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$", id);
    }
}
