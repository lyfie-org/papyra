using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Papyra.Tests;

// GET /api/users/search — the mention typeahead's directory.
//
// This is the only endpoint a non-admin can use to learn about other accounts, so
// the tests are mostly about what it refuses to say: no roster dump, no fields
// beyond the handle and display name, nothing at all for a caller who isn't signed
// in. The rate limit is deliberately not asserted here — it is a wall-clock
// behaviour and would make the suite slow and flaky; it's covered by inspection
// and by the live edge harness.
public sealed class UserDirectoryEndpointTests
{
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-dir-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });

        return (factory, dir);
    }

    // Admin + the named accounts, all with the same throwaway password. Returns an
    // authenticated client for `signInAs`, which is a plain User unless it's "admin".
    private static async Task<HttpClient> SeedAndSignInAsync(
        WebApplicationFactory<Program> factory, string signInAs, params string[] usernames)
    {
        const string Pw = "hunter2!";

        var adminClient = factory.CreateClient();
        var setup = await adminClient.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: Pw));
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);

        foreach (var name in usernames)
        {
            var res = await adminClient.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
                Username: name, Name: $"{name} display", Email: $"{name}@example.com",
                Password: Pw, Role: "User"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        }

        if (signInAs == "admin") return adminClient;

        var client = factory.CreateClient();     // fresh cookie jar
        var login = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(signInAs, Pw));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static async Task<string[]> SearchAsync(HttpClient client, string q)
    {
        var res = await client.GetAsync($"/api/users/search?q={Uri.EscapeDataString(q)}");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var rows = await res.Content.ReadFromJsonAsync<JsonElement>();
        return [.. rows.EnumerateArray().Select(r => r.GetProperty("username").GetString()!)];
    }

    [Fact]
    public async Task Search_LetsANonAdminResolveAPrefix()
    {
        var (factory, dir) = NewApp();
        try
        {
            // bea is a plain User; /api/auth/users would 403 for them.
            var client = await SeedAndSignInAsync(factory, "bea", "bea", "beatrice", "cal");

            Assert.Equal(["beatrice"], await SearchAsync(client, "beat"));
            Assert.Equal(["cal"], await SearchAsync(client, "ca"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_MatchesOnPrefixOnly_NotSubstring()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "beatrice");
            // "atr" occurs inside "beatrice" but is not a prefix of it.
            Assert.Empty(await SearchAsync(client, "atr"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_IsCaseInsensitive()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "Beatrice");
            Assert.Equal(["Beatrice"], await SearchAsync(client, "bEaT"));
        }
        finally { Cleanup(factory, dir); }
    }

    // Typing `@` is precisely when someone wants to see who they can mention, so
    // a short query answers rather than stonewalling. This endpoint used to
    // require two characters — the dropdown then stayed empty until the third
    // keystroke, which reads as "mentions are broken".
    [Fact]
    public async Task Search_ListsAccountsForAnEmptyQuery()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "bea", "beatrice");
            var hits = await SearchAsync(client, "");
            Assert.Equal(["admin", "bea", "beatrice"], hits);   // everyone but the caller
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_NarrowsFromTheFirstCharacter()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "bea", "beatrice");
            Assert.Equal(["bea", "beatrice"], await SearchAsync(client, "b"));
            Assert.Equal(["bea", "beatrice"], await SearchAsync(client, " b "));  // trimmed
        }
        finally { Cleanup(factory, dir); }
    }

    // Two independent things keep these from matching: EF escapes LIKE
    // metacharacters in the parameter (`LIKE @p ESCAPE '\'`), and the endpoint
    // rejects anything outside the username charset before querying. Either alone
    // suffices — this pins the behaviour so neither can be dropped unnoticed.
    [Theory]
    [InlineData("%")]        // LIKE wildcard: a roster dump if ever interpreted
    [InlineData("%%")]
    [InlineData("__")]       // LIKE single-char wildcard
    [InlineData("b%")]
    [InlineData("b_a")]
    [InlineData("' OR 1=1 --")]
    public async Task Search_RefusesWildcardsInsteadOfDumpingTheRoster(string q)
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "bea", "beatrice");
            Assert.Empty(await SearchAsync(client, q));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_ExcludesTheCallerThemselves()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "bea", "bea", "beatrice");
            // A self-mention is dropped at delivery, so offering it would only
            // invite a ping that silently goes nowhere.
            Assert.Equal(["beatrice"], await SearchAsync(client, "bea"));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_CapsTheNumberOfRowsItReturns()
    {
        var (factory, dir) = NewApp();
        try
        {
            string[] many = [.. Enumerable.Range(0, 12).Select(i => $"user{i:00}")];
            var client = await SeedAndSignInAsync(factory, "user00", many);

            var hits = await SearchAsync(client, "user");
            Assert.Equal(8, hits.Length);
            Assert.DoesNotContain("user00", hits);   // the caller, excluded
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_ReturnsTheHandleAndDisplayNameAndNothingElse()
    {
        var (factory, dir) = NewApp();
        try
        {
            var client = await SeedAndSignInAsync(factory, "cal", "cal", "beatrice");
            var res = await client.GetAsync("/api/users/search?q=beat");
            var rows = await res.Content.ReadFromJsonAsync<JsonElement>();
            var row = rows.EnumerateArray().Single();

            Assert.Equal(["username", "name"],
                row.EnumerateObject().Select(p => p.Name).ToArray());
            // Specifically: not the id, the email, or the role.
            var raw = await res.Content.ReadAsStringAsync();
            Assert.DoesNotContain("example.com", raw);
            Assert.DoesNotContain("User", raw, StringComparison.Ordinal);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Search_RefusesAnAnonymousCaller()
    {
        var (factory, dir) = NewApp();
        try
        {
            await SeedAndSignInAsync(factory, "admin", "bea");
            var anon = factory.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,   // a 302 to a login page is not a pass
            });

            var res = await anon.GetAsync("/api/users/search?q=bea");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        // SQLite pools connections by string; release the file handle before
        // deleting the temp vault so cleanup doesn't hit a locked papyra.db.
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { /* temp dir */ }
    }
}
