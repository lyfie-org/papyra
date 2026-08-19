using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Models;

namespace Papyra.Tests;

/// <summary>
/// The development sign-in bypass hands out a session with no credential. These
/// tests are the reason it is safe to have in the tree: they assert it is inert
/// unless the environment is Development AND `Papyra:DevSignInAs` names a user.
/// </summary>
public sealed class DevSignInBypassTests
{
    private static (WebApplicationFactory<Program> Factory, string Dir) NewApp(
        string environment, string? devSignInAs)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-api-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.UseSetting("Papyra:DataDir", dir);
            if (devSignInAs is not null) b.UseSetting("Papyra:DevSignInAs", devSignInAs);
        });

        return (factory, dir);
    }

    // The bypass only resolves an existing user, so the admin has to exist first.
    // Setup signs the caller in, hence the fresh client for the assertions.
    private static async Task SeedAdminAsync(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        var res = await client.PostAsJsonAsync("/api/auth/setup", new SetupRequest(
            Username: "admin", Name: "Admin", Email: "a@b.c", Password: "hunter2!"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        Directory.Delete(dir, recursive: true);
    }

    [Fact]
    public async Task Development_WithoutTheSetting_StillRequiresSigningIn()
    {
        var (factory, dir) = NewApp("Development", devSignInAs: null);
        try
        {
            await SeedAdminAsync(factory);
            var anonymous = factory.CreateClient();
            var res = await anonymous.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Production_WithTheSetting_StillRequiresSigningIn()
    {
        // The dangerous case: someone leaves Papyra:DevSignInAs in a config file
        // that ships. Outside Development the middleware is never registered.
        var (factory, dir) = NewApp("Production", devSignInAs: "admin");
        try
        {
            await SeedAdminAsync(factory);
            var anonymous = factory.CreateClient();
            var res = await anonymous.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Development_WithTheSetting_SignsInAsThatUser()
    {
        var (factory, dir) = NewApp("Development", devSignInAs: "admin");
        try
        {
            await SeedAdminAsync(factory);
            var anonymous = factory.CreateClient();

            var me = await anonymous.GetAsync("/api/auth/me");
            Assert.Equal(HttpStatusCode.OK, me.StatusCode);
            var body = await me.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
            Assert.Equal("admin", body.GetProperty("username").GetString());

            var notes = await anonymous.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.OK, notes.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task Development_NamingAUserThatDoesNotExist_GrantsNothing()
    {
        var (factory, dir) = NewApp("Development", devSignInAs: "nobody");
        try
        {
            await SeedAdminAsync(factory);
            var anonymous = factory.CreateClient();
            var res = await anonymous.GetAsync("/api/notes");
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }
}
