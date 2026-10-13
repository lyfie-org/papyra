using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Sharing a smart collection: as JSON to paste anywhere, or sent to someone here,
// who adds a copy from their notification tray. Only the name and rules travel.
public sealed class CollectionSharingTests
{
    private const string Pw = "hunter2!";

    private static string Rules(string field, string value) =>
        JsonSerializer.Serialize(new { match = "all", conditions = new[] { new { field, value } } });

    // ── The JSON form (pure) ─────────────────────────────────────────────────────

    [Fact]
    public void Write_ThenRead_RoundTripsNameAndRules()
    {
        var json = SmartCollectionShare.Write("Trips", Rules("tag", "Japan"));
        Assert.Contains("\"papyraCollection\":1", json);

        Assert.True(SmartCollectionShare.TryRead(json, out var name, out var rules, out _));
        Assert.Equal("Trips", name);
        var parsed = JsonSerializer.Deserialize<SmartRules>(rules, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        Assert.Equal("all", parsed.Match);
        Assert.Equal(new SmartRule("tag", "Japan"), Assert.Single(parsed.Conditions!));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"name\":\"x\",\"rules\":{\"match\":\"all\",\"conditions\":[{\"field\":\"tag\",\"value\":\"a\"}]}}")]
    [InlineData("{\"papyraCollection\":2,\"name\":\"x\",\"rules\":{\"match\":\"all\",\"conditions\":[{\"field\":\"tag\",\"value\":\"a\"}]}}")]
    [InlineData("{\"papyraCollection\":1,\"name\":\" \",\"rules\":{\"match\":\"all\",\"conditions\":[{\"field\":\"tag\",\"value\":\"a\"}]}}")]
    [InlineData("{\"papyraCollection\":1,\"name\":\"x\",\"rules\":{\"match\":\"all\",\"conditions\":[]}}")]
    [InlineData("{\"papyraCollection\":1,\"name\":\"x\",\"rules\":{\"match\":\"all\",\"conditions\":[{\"field\":\"owner\",\"value\":\"a\"}]}}")]
    [InlineData("{\"papyraCollection\":1,\"name\":\"x\",\"rules\":{\"match\":\"all\",\"conditions\":[{\"field\":\"tag\",\"value\":3}]}}")]
    public void Read_RefusesWhatIsNotACollection(string json)
    {
        Assert.False(SmartCollectionShare.TryRead(json, out _, out _, out var error));
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Fact]
    public void Read_KeepsOnlyKnownParts_AndAcceptsPascalCase()
    {
        var json = "{\"PapyraCollection\":1,\"Name\":\"  Work \",\"Rules\":{\"Match\":\"ANY\",\"Conditions\":["
            + "{\"Field\":\"TAG\",\"Value\":\"a\",\"extra\":true}]},\"notes\":[\"secret\"]}";
        Assert.True(SmartCollectionShare.TryRead(json, out var name, out var rules, out _));
        Assert.Equal("Work", name);
        Assert.Equal("{\"match\":\"any\",\"conditions\":[{\"field\":\"tag\",\"value\":\"a\"}]}", rules);
    }

    [Fact]
    public void UniqueName_NumbersATakenName()
    {
        Assert.Equal("Trips", SmartCollectionShare.UniqueName("Trips", ["Work"]));
        Assert.Equal("Trips (2)", SmartCollectionShare.UniqueName("Trips", ["trips"]));
        Assert.Equal("Trips (3)", SmartCollectionShare.UniqueName("Trips", ["Trips", "Trips (2)"]));
    }

    // ── Endpoints ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Export_ThenImport_AddsACopyUnderAFreeName()
    {
        await WithAppAsync(async (factory, owner) =>
        {
            var id = await CreateAsync(owner, "Japan", Rules("tag", "Japan"));

            var export = await owner.GetAsync($"/api/collections/{id}/export");
            Assert.Equal(HttpStatusCode.OK, export.StatusCode);
            var json = await export.Content.ReadAsStringAsync();
            Assert.Contains("\"name\":\"Japan\"", json);

            var import = await owner.PostAsync("/api/collections/import",
                new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.OK, import.StatusCode);
            Assert.Equal("Japan (2)", (await import.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString());

            var bad = await owner.PostAsync("/api/collections/import",
                new StringContent("{\"papyraCollection\":1,\"name\":\"x\"}", System.Text.Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

            Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/api/collections/{id + 999}/export")).StatusCode);
            Assert.Equal(2, (await owner.GetFromJsonAsync<List<JsonElement>>("/api/collections"))!.Count);
        });
    }

    [Fact]
    public async Task Send_OffersTheCollectionAsItWas_AndAcceptAddsIt()
    {
        await WithAppAsync(async (factory, owner) =>
        {
            var bea = await MemberAsync(factory, owner, "bea");
            await CreateAsync(bea, "Japan", Rules("tag", "other")); // bea already has a "Japan"
            var id = await CreateAsync(owner, "Japan", Rules("tag", "Japan"));

            Assert.Equal(HttpStatusCode.OK,
                (await owner.PostAsJsonAsync($"/api/collections/{id}/send", new { username = "@bea" })).StatusCode);

            // Changing it afterwards doesn't change what was offered.
            await owner.PutAsJsonAsync($"/api/collections/{id}", new { name = "Changed", rulesJson = Rules("text", "x") });

            var offer = (await bea.GetFromJsonAsync<List<JsonElement>>("/api/notifications"))!
                .Single(n => n.GetProperty("kind").GetString() == "collection_offer");
            Assert.Equal("owner", offer.GetProperty("actor").GetString());
            Assert.True(offer.GetProperty("available").GetBoolean());
            Assert.Equal("Japan", offer.GetProperty("collectionName").GetString());
            Assert.Contains("Japan", offer.GetProperty("collectionRules").GetString());

            var nid = offer.GetProperty("id").GetInt32();
            var accept = await bea.PostAsync($"/api/notifications/{nid}/accept", null);
            Assert.Equal(HttpStatusCode.OK, accept.StatusCode);
            var added = await accept.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("Japan (2)", added.GetProperty("name").GetString());
            Assert.Contains("\"value\":\"Japan\"", added.GetProperty("rulesJson").GetString());

            // Taken once: the entry is gone and can't be accepted again.
            Assert.DoesNotContain((await bea.GetFromJsonAsync<List<JsonElement>>("/api/notifications"))!,
                n => n.GetProperty("id").GetInt32() == nid);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.PostAsync($"/api/notifications/{nid}/accept", null)).StatusCode);
            // Nobody else can take it either.
            Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsync($"/api/notifications/{nid}/accept", null)).StatusCode);
        });
    }

    [Fact]
    public async Task Send_RefusesNobodySelfAndOthersCollections()
    {
        await WithAppAsync(async (factory, owner) =>
        {
            var bea = await MemberAsync(factory, owner, "bea");
            var id = await CreateAsync(owner, "Japan", Rules("tag", "Japan"));

            Assert.Equal(HttpStatusCode.NotFound,
                (await owner.PostAsJsonAsync($"/api/collections/{id}/send", new { username = "nobody" })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync($"/api/collections/{id}/send", new { username = "owner" })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync($"/api/collections/{id}/send", new { username = " " })).StatusCode);
            // bea can't send (or read) the owner's collection.
            Assert.Equal(HttpStatusCode.NotFound,
                (await bea.PostAsJsonAsync($"/api/collections/{id}/send", new { username = "owner" })).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await bea.GetAsync($"/api/collections/{id}/export")).StatusCode);
        });
    }

    [Fact]
    public async Task Accept_RefusesOtherKindsOfNotification()
    {
        await WithAppAsync(async (factory, owner) =>
        {
            var bea = await MemberAsync(factory, owner, "bea");
            await owner.PutAsJsonAsync("/api/notes/plan", new NoteWrite(
                Title: "Plan", Tags: null, Color: null, Pinned: false, Archived: false, Body: "x", Kind: null, Secure: false));
            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/api/notes/plan/shares", new ShareWrite(
                Kind: "user", Access: "view", GranteeUsername: "bea", ExpiresUtc: null, MaxViews: null))).StatusCode);

            var shared = (await bea.GetFromJsonAsync<List<JsonElement>>("/api/notifications"))!
                .Single(n => n.GetProperty("kind").GetString() == "shared");
            Assert.Equal(HttpStatusCode.BadRequest,
                (await bea.PostAsync($"/api/notifications/{shared.GetProperty("id").GetInt32()}/accept", null)).StatusCode);
            Assert.True(shared.GetProperty("collectionName").ValueKind == JsonValueKind.Null);
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    private static async Task<int> CreateAsync(HttpClient client, string name, string rulesJson)
    {
        var res = await client.PostAsJsonAsync("/api/collections", new { name, rulesJson });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static async Task<HttpClient> MemberAsync(WebApplicationFactory<Program> factory, HttpClient owner, string username)
    {
        var provision = await owner.PostAsJsonAsync("/api/auth/users", new ProvisionRequest(
            Username: username, Name: username, Email: $"{username}@b.c", Password: Pw, Role: "User"));
        Assert.Equal(HttpStatusCode.OK, provision.StatusCode);
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync(username, Pw)).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static async Task WithAppAsync(Func<WebApplicationFactory<Program>, HttpClient, Task> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-collection-share-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
        });
        try
        {
            var owner = factory.CreateClient();
            var setup = await owner.PostSetupAsync(new SetupRequest(
                Username: "owner", Name: "Owner", Email: "o@b.c", Password: Pw));
            Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
            await body(factory, owner);
        }
        finally
        {
            factory.Dispose();
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }
}
