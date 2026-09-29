using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Collab;

namespace Papyra.Tests;

/// <summary>
/// The API half of live collaboration: room tickets, the engine's loopback data
/// path, and the guards that keep classic writes from clobbering a live room.
/// The engine itself is replaced by <see cref="FakeEngine"/>; papyra.collab has
/// its own suite.
/// </summary>
public sealed class CollabTests
{
    private const string Pw = "hunter2!";
    private const string Secret = "test-collab-secret-0123456789abcdef0123456789abcdef";

    /// <summary>Same vector as papyra.collab/src/ticket.test.ts — both sides must agree byte for byte.</summary>
    private const string TicketVector =
        "eyJ2IjoxLCJ1aWQiOjMsIm5hbWUiOiJBZGEiLCJvd25lciI6Nywibm90ZSI6IkluYm94IiwiYWNjZXNzIjoiZWRpdCIsImlhdCI6MTgwMDAwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDYwfQ"
        + ".FPaundGhcCenfDvoWwLM2ZVRxQk4kYQFBhGWkzo0TdU";

    private sealed class FakeEngine : ICollabEngine
    {
        public CollabStatus Status { get; set; } = CollabStatus.Ok;
        public Uri? BaseUrl => new("http://127.0.0.1:1/");
        public string Secret => CollabTests.Secret;
        public TimeSpan TicketLifetime => TimeSpan.FromSeconds(60);
        public ConcurrentDictionary<string, bool> ActiveRooms { get; } = new();
        public ConcurrentQueue<string> Calls { get; } = new();

        public Task<bool> IsRoomActiveAsync(string ownerUid, string noteId, CancellationToken ct = default) =>
            Task.FromResult(ActiveRooms.ContainsKey($"{ownerUid}:{noteId}"));
        public Task KickAsync(string ownerUid, string noteId, int uid, CancellationToken ct = default)
        {
            Calls.Enqueue($"kick {ownerUid}:{noteId} {uid}");
            return Task.CompletedTask;
        }
        public Task CloseAsync(string ownerUid, string noteId, bool flush, CancellationToken ct = default)
        {
            Calls.Enqueue($"close {ownerUid}:{noteId} {(flush ? "flush" : "discard")}");
            return Task.CompletedTask;
        }
        public Task ExternalChangeAsync(string ownerUid, string noteId, string body, CancellationToken ct = default)
        {
            Calls.Enqueue($"external {ownerUid}:{noteId}");
            return Task.CompletedTask;
        }
        public Task FlushAsync(string ownerUid, string noteId, CancellationToken ct = default)
        {
            Calls.Enqueue($"flush {ownerUid}:{noteId}");
            return Task.CompletedTask;
        }
        public Task RestoreAsync(string ownerUid, string noteId, string body, CancellationToken ct = default)
        {
            Calls.Enqueue($"restore {ownerUid}:{noteId}");
            return Task.CompletedTask;
        }
    }

    private static (WebApplicationFactory<Program> Factory, string Dir, FakeEngine Engine) NewApp(bool unthrottled = false)
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-collab-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var engine = new FakeEngine();
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", dir);
            b.UseSetting("Collab:Secret", Secret);
            if (unthrottled) b.UseSetting("Papyra:SnapshotMinIntervalSeconds", "0");
            b.ConfigureTestServices(services => services.AddSingleton<ICollabEngine>(engine));
        });
        return (factory, dir, engine);
    }

    private static void Cleanup(WebApplicationFactory<Program> factory, string dir)
    {
        factory.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
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
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/auth/login", new LoginRequest(username, Pw))).StatusCode);
        await TestAuth.CompleteForcedPasswordChangeAsync(client, Pw);
        return client;
    }

    private static Task<HttpResponseMessage> WriteAsync(HttpClient client, string id, string body,
        bool secure = false, string title = "Plan", bool collabHeader = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, $"/api/notes/{id}")
        {
            Content = JsonContent.Create(new NoteWrite(Title: title, Tags: null, Color: null, Pinned: false,
                Archived: false, Body: body, Kind: null, Secure: secure)),
        };
        if (collabHeader) request.Headers.Add(CollabEndpoints.CollabClientHeader, "frontmatter");
        return client.SendAsync(request);
    }

    private static async Task<int> ShareAsync(HttpClient owner, string id, string grantee, string access)
    {
        var res = await owner.PostAsJsonAsync($"/api/notes/{id}/shares", new ShareWrite(
            Kind: "user", Access: access, GranteeUsername: grantee, ExpiresUtc: null, MaxViews: null));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static async Task<int> MyIdAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetInt32();

    private static HttpRequestMessage Internal(HttpMethod method, string path, object? body = null, string? secret = Secret)
    {
        var request = new HttpRequestMessage(method, path);
        if (secret is not null) request.Headers.Add("X-Collab-Secret", secret);
        if (body is not null) request.Content = JsonContent.Create(body);
        return request;
    }

    private static JsonElement DecodeTicket(string ticket)
    {
        var part = ticket.Split('.')[0].Replace('-', '+').Replace('_', '/');
        part = part.PadRight(part.Length + (4 - part.Length % 4) % 4, '=');
        return JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(part))).RootElement;
    }

    // ── Tickets ────────────────────────────────────────────────────────────────

    [Fact]
    public void TicketWireFormatMatchesTheEngine()
    {
        var ticket = new CollabTicket(1, 3, "Ada", 7, "Inbox", "edit", 1_800_000_000_000, 1_800_000_060);
        Assert.Equal(TicketVector, CollabTicket.Mint(new string('a', 64), ticket));
        Assert.Equal("7:Inbox", CollabTicket.RoomName(7, "Inbox"));
    }

    [Fact]
    public async Task OwnerAndGranteesGetTicketsWithTheirAccessOthersDoNot()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            var cal = await MemberAsync(factory, owner, "cal");
            await WriteAsync(owner, "n1", "Hello");
            var shareId = await ShareAsync(owner, "n1", "bea", "view");
            var ownerId = await MyIdAsync(owner);

            var mine = await owner.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("n1", null));
            Assert.Equal(HttpStatusCode.OK, mine.StatusCode);
            var mineBody = await mine.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal($"{ownerId}:n1", mineBody.GetProperty("room").GetString());
            var payload = DecodeTicket(mineBody.GetProperty("ticket").GetString()!);
            Assert.Equal("edit", payload.GetProperty("access").GetString());
            Assert.Equal(ownerId, payload.GetProperty("owner").GetInt32());

            var theirs = await bea.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest(null, shareId));
            Assert.Equal(HttpStatusCode.OK, theirs.StatusCode);
            var theirsBody = await theirs.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("view", theirsBody.GetProperty("access").GetString());
            Assert.Equal($"{ownerId}:n1", theirsBody.GetProperty("room").GetString());

            // Someone else's share id is not a key.
            Assert.Equal(HttpStatusCode.NotFound,
                (await cal.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest(null, shareId))).StatusCode);
            // A note id alone only ever means "mine" — cal has no n1.
            Assert.Equal(HttpStatusCode.NotFound,
                (await cal.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("n1", null))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LockedNotesNeverGetARoomAndADownEngineSays503()
    {
        var (factory, dir, engine) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "s1", "secret", secure: true);
            Assert.Equal(HttpStatusCode.Gone,
                (await owner.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("s1", null))).StatusCode);

            await WriteAsync(owner, "n1", "open");
            engine.Status = CollabStatus.Degraded;
            var down = await owner.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("n1", null));
            Assert.Equal(HttpStatusCode.ServiceUnavailable, down.StatusCode);
            Assert.Equal("collab_unavailable", (await down.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task TicketEndpointIsRateLimitedPerAccount()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "n1", "Hello");
            var bea = await MemberAsync(factory, owner, "bea");

            HttpStatusCode last = default;
            for (var i = 0; i < 65; i++)
                last = (await owner.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("n1", null))).StatusCode;
            Assert.Equal(HttpStatusCode.TooManyRequests, last);

            // Another account has its own budget.
            var other = await bea.PostAsJsonAsync("/api/collab/ticket", new CollabTicketRequest("nope", null));
            Assert.NotEqual(HttpStatusCode.TooManyRequests, other.StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Engine data path ───────────────────────────────────────────────────────

    [Fact]
    public async Task InternalRoutesAreInvisibleWithoutTheSecret()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "n1", "Hello");
            var ownerId = await MyIdAsync(owner);
            var anon = factory.CreateClient();

            Assert.Equal(HttpStatusCode.NotFound,
                (await anon.SendAsync(Internal(HttpMethod.Get, $"/internal/collab/notes/{ownerId}/n1", secret: null))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound,
                (await anon.SendAsync(Internal(HttpMethod.Get, $"/internal/collab/notes/{ownerId}/n1", secret: "wrong"))).StatusCode);
            Assert.Equal(HttpStatusCode.OK,
                (await anon.SendAsync(Internal(HttpMethod.Get, $"/internal/collab/notes/{ownerId}/n1"))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task SavesAreHashCheckedAndPersistTheRoomState()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "n1", "Hello", title: "Plan");
            var ownerId = await MyIdAsync(owner);
            var engine = factory.CreateClient();
            var url = $"/internal/collab/notes/{ownerId}/n1";

            var loaded = await (await engine.SendAsync(Internal(HttpMethod.Get, url))).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("Hello", loaded.GetProperty("body").GetString());
            Assert.Equal(CollabHash.Of("Hello"), loaded.GetProperty("hash").GetString());
            Assert.Equal(JsonValueKind.Null, loaded.GetProperty("yState").ValueKind);

            // Stale base → 409 with what's on disk; nothing written.
            var stale = await engine.SendAsync(Internal(HttpMethod.Put, url,
                new CollabSaveRequest("Clobber", CollabHash.Of("old"), null, null)));
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            Assert.Equal("Hello", (await stale.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("body").GetString());

            var state = Convert.ToBase64String([1, 2, 3, 4]);
            var saved = await engine.SendAsync(Internal(HttpMethod.Put, url,
                new CollabSaveRequest("Hello together", CollabHash.Of("Hello"), state, [ownerId])));
            Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
            Assert.Equal(CollabHash.Of("Hello together"),
                (await saved.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("hash").GetString());

            // The file (source of truth) has it — body only; metadata untouched.
            var note = (await owner.GetFromJsonAsync<JsonElement>("/api/notes")).EnumerateArray().Single(n => n.GetProperty("id").GetString() == "n1");
            Assert.Equal("Hello together", note.GetProperty("body").GetString());
            Assert.Equal("Plan", note.GetProperty("title").GetString());

            var reloaded = await (await engine.SendAsync(Internal(HttpMethod.Get, url))).Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(state, reloaded.GetProperty("yState").GetString());
            Assert.Equal(reloaded.GetProperty("hash").GetString(), reloaded.GetProperty("yStateHash").GetString());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LockedOrTrashedNotesAreGoneToTheEngine()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var ownerId = await MyIdAsync(owner);
            var engine = factory.CreateClient();
            await WriteAsync(owner, "s1", "secret", secure: true);
            await WriteAsync(owner, "t1", "bin me");
            await owner.PostAsync("/api/notes/t1/trash", null);

            Assert.Equal(HttpStatusCode.Gone, (await engine.SendAsync(Internal(HttpMethod.Put,
                $"/internal/collab/notes/{ownerId}/s1", new CollabSaveRequest("x", CollabHash.Of("secret"), null, null)))).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await engine.SendAsync(Internal(HttpMethod.Put,
                $"/internal/collab/notes/{ownerId}/t1", new CollabSaveRequest("x", CollabHash.Of("bin me"), null, null)))).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    // ── Guards on the classic write paths ──────────────────────────────────────

    [Fact]
    public async Task ClassicBodyWritesCannotClobberALiveRoom()
    {
        var (factory, dir, engine) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteAsync(owner, "n1", "Room text");
            var shareId = await ShareAsync(owner, "n1", "bea", "edit");
            var ownerId = await MyIdAsync(owner);
            engine.ActiveRooms[$"{ownerId}:n1"] = true;

            var clobber = await WriteAsync(owner, "n1", "Old tab text");
            Assert.Equal(HttpStatusCode.Conflict, clobber.StatusCode);
            Assert.Equal("collab_active", (await clobber.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

            var shared = await bea.PutAsJsonAsync($"/api/shares/incoming/{shareId}", new SharedBodyWrite("Grantee old tab"));
            Assert.Equal(HttpStatusCode.Conflict, shared.StatusCode);

            // Metadata saves still work: a live editor's header keeps the disk body
            // even if its draft differs; an unchanged body passes anyway.
            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "n1", "draft ahead of disk", title: "Renamed", collabHeader: true)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "n1", "Room text", title: "Renamed again")).StatusCode);
            var note = (await owner.GetFromJsonAsync<JsonElement>("/api/notes")).EnumerateArray().Single(n => n.GetProperty("id").GetString() == "n1");
            Assert.Equal("Room text", note.GetProperty("body").GetString());
            Assert.Equal("Renamed again", note.GetProperty("title").GetString());

            // No room → classic writes behave exactly as before.
            engine.ActiveRooms.Clear();
            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "n1", "Solo again")).StatusCode);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task RevokingTrashingAndDeletingSteerTheRoom()
    {
        var (factory, dir, engine) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            await WriteAsync(owner, "n1", "Shared");
            var shareId = await ShareAsync(owner, "n1", "bea", "edit");
            var ownerId = await MyIdAsync(owner);
            var beaId = await MyIdAsync(bea);

            Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/api/shares/{shareId}")).StatusCode);
            Assert.Contains($"kick {ownerId}:n1 {beaId}", engine.Calls);

            await owner.PostAsync("/api/notes/n1/trash", null);
            Assert.Contains($"close {ownerId}:n1 flush", engine.Calls);

            await owner.DeleteAsync("/api/notes/n1");
            Assert.Contains($"close {ownerId}:n1 discard", engine.Calls);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task LockingANoteOpenLiveSavesTheRoomThenClosesIt()
    {
        var (factory, dir, engine) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            await WriteAsync(owner, "n1", "Plain");
            var ownerId = await MyIdAsync(owner);
            engine.ActiveRooms[$"{ownerId}:n1"] = true;

            Assert.Equal(HttpStatusCode.OK, (await WriteAsync(owner, "n1", "Plain", secure: true)).StatusCode);
            Assert.Contains($"close {ownerId}:n1 flush", engine.Calls);
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task HistoryNamesTheEditorsOfEachRoomVersion()
    {
        var (factory, dir, _) = NewApp(unthrottled: true);
        try
        {
            var owner = await OwnerAsync(factory);
            var bea = await MemberAsync(factory, owner, "bea");
            var ownerId = await MyIdAsync(owner);
            var beaId = await MyIdAsync(bea);
            await WriteAsync(owner, "n1", "v1");
            var engine = factory.CreateClient();
            var url = $"/internal/collab/notes/{ownerId}/n1";
            var state = Convert.ToBase64String([1]);

            // Two saves by the room: the second archives what the first wrote,
            // crediting the people behind it. The very first archived text
            // (v1) came from outside the room, so it has no editors.
            Assert.Equal(HttpStatusCode.OK, (await engine.SendAsync(Internal(HttpMethod.Put, url,
                new CollabSaveRequest("v2", CollabHash.Of("v1"), state, [ownerId, beaId])))).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await engine.SendAsync(Internal(HttpMethod.Put, url,
                new CollabSaveRequest("v3", CollabHash.Of("v2"), state, [beaId])))).StatusCode);

            var versions = (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/snapshots")).EnumerateArray().ToList();
            Assert.Equal(2, versions.Count);
            var credited = versions.Single(v => v.GetProperty("editors").GetArrayLength() > 0)
                .GetProperty("editors").EnumerateArray().Select(e => e.GetString()).ToList();
            Assert.Equal(["Owner", "bea"], credited.OrderBy(n => n, StringComparer.Ordinal).ToList());
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task RestoringWhileARoomIsLiveSavesItThenReplacesItsText()
    {
        var (factory, dir, engine) = NewApp();
        try
        {
            var owner = await OwnerAsync(factory);
            var ownerId = await MyIdAsync(owner);
            await WriteAsync(owner, "n1", "Original");
            var http = factory.CreateClient();
            var url = $"/internal/collab/notes/{ownerId}/n1";
            Assert.Equal(HttpStatusCode.OK, (await http.SendAsync(Internal(HttpMethod.Put, url,
                new CollabSaveRequest("Edited live", CollabHash.Of("Original"), null, [ownerId])))).StatusCode);

            var original = (await owner.GetFromJsonAsync<JsonElement>("/api/notes/n1/snapshots")).EnumerateArray().Single();
            engine.ActiveRooms[$"{ownerId}:n1"] = true;
            var restored = await owner.PostAsync($"/api/notes/n1/restore/{original.GetProperty("id").GetString()}", null);
            Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
            Assert.Equal("Original", (await restored.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("body").GetString());

            var calls = engine.Calls.ToList();
            var flush = calls.IndexOf($"flush {ownerId}:n1");
            var restore = calls.IndexOf($"restore {ownerId}:n1");
            Assert.True(flush >= 0 && restore > flush, string.Join(" | ", calls));
        }
        finally { Cleanup(factory, dir); }
    }

    [Fact]
    public async Task HealthReportsTheCollabEngine()
    {
        var (factory, dir, _) = NewApp();
        try
        {
            var health = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
            Assert.Equal("Healthy", health.GetProperty("status").GetString());
            Assert.Equal("ok", health.GetProperty("collab").GetString());
        }
        finally { Cleanup(factory, dir); }
    }
}
