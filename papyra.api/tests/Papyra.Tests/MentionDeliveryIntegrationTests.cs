using System.Diagnostics;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Tests;

// Phase 15.2 — the cross-tenant write.
//
// MentionDeliveryService is the only code path in Papyra that writes into a vault
// the caller does not own, so these tests are about the *blast radius* of that
// write rather than about mention parsing (MentionDeliveryTests covers the pure
// parsing). The invariant under test: whatever a sender puts in a note body, at
// most one file may change per delivery, and it must be the recipient's own
// Inbox.md.
//
// The note id here is deliberately hostile in places. The notes endpoint already
// rejects such ids via PathGuard.IsValidNoteId, so these cases are defence in
// depth: they assert that even an id which somehow reached the queue travels as
// *text* inside the reference line and never as a path segment.
//
// Each test gets a fresh instance — xUnit constructs the class per test — so the
// temp vault and the in-memory DB are per-test, and the file assertions can be
// exact rather than "contains".
public sealed class MentionDeliveryIntegrationTests : IDisposable
{
    private const string Owner = "ana";

    // A username that the mention regex accepts yet reads like a path segment.
    // It must only ever reach the users table — the delivery path is built from
    // the recipient's numeric id, never from the name typed in the note.
    private const string DottedName = "a..b";

    private readonly SqliteConnection _conn;
    private readonly ServiceProvider _sp;
    private readonly string _usersDir;
    private readonly VaultObserverOptions _vault;
    private readonly MentionDeliveryService _svc;
    private readonly VaultState _state = new();

    private readonly int _ownerId;
    private readonly int _beaId;
    private readonly int _calId;
    private readonly int _dottedId;

    public MentionDeliveryIntegrationTests()
    {
        _usersDir = Path.Combine(Path.GetTempPath(), "papyra-mention-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_usersDir);

        // One shared in-memory DB across scopes: keep the connection open for its life.
        _conn = new SqliteConnection("DataSource=:memory:");
        _conn.Open();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSignalR();   // a real hub context with no connections; SendAsync is a no-op
        services.AddDbContext<AppDbContext>(o => o.UseSqlite(_conn));
        _sp = services.BuildServiceProvider();

        using (var scope = _sp.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Database.EnsureCreated();
            var owner = new User { Username = Owner };
            var bea = new User { Username = "bea" };
            var cal = new User { Username = "cal" };
            var dotted = new User { Username = DottedName };
            db.Users.AddRange(owner, bea, cal, dotted);
            db.SaveChanges();
            (_ownerId, _beaId, _calId, _dottedId) = (owner.Id, bea.Id, cal.Id, dotted.Id);
        }

        _vault = new VaultObserverOptions { UsersDir = _usersDir };
        _svc = new MentionDeliveryService(
            _sp.GetRequiredService<IServiceScopeFactory>(),
            new MarkdownStorageService(),
            _vault,
            new WriteRing(new MemoryCache(new MemoryCacheOptions())),
            _state,
            _sp.GetRequiredService<IHubContext<NotesHub>>(),
            // Unconfigured on purpose: these tests are about the cross-tenant
            // write, and mail must never be able to affect it.
            new EmailSender(
                new InstanceConfigStore(_sp.GetRequiredService<IServiceScopeFactory>(),
                    NullLogger<InstanceConfigStore>.Instance),
                NullLogger<EmailSender>.Instance),
            NullLogger<MentionDeliveryService>.Instance);
        _svc.StartAsync(default).GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _svc.StopAsync(default).GetAwaiter().GetResult();
        _sp.Dispose();
        _conn.Close();
        try { Directory.Delete(_usersDir, recursive: true); } catch (IOException) { /* temp dir */ }
    }

    // ---- the write is confined to one file ---------------------------------

    [Fact]
    public async Task Delivery_TouchesExactlyOneFile_TheRecipientsInbox()
    {
        Send("standup", "Can @bea take the migration? ^ping0001");
        await WaitForFileAsync(InboxOf(_beaId));

        Assert.Equal(Expect(_beaId), AllFiles());
        // The sender's own vault is not created, let alone written to.
        Assert.False(Directory.Exists(_vault.UserNotesDir(_ownerId.ToString())));

        var inbox = await File.ReadAllTextAsync(InboxOf(_beaId));
        Assert.Contains("![[standup#^ping0001]]", inbox);
        Assert.Contains($"@{Owner}", inbox);
        // A pointer, not a copy: the mentioned block's prose stays in the author's vault.
        Assert.DoesNotContain("take the migration", inbox);
        // kind: inbox must survive the write, or the inbox reverts to a plain note.
        Assert.Contains("kind: inbox", inbox);
    }

    [Fact]
    public async Task Delivery_RecordsAGrantScopedToTheOneBlock()
    {
        Send("standup", "Can @bea take this? ^ping0001");
        await WaitForFileAsync(InboxOf(_beaId));

        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var grant = await db.BlockGrants.SingleAsync();

        Assert.Equal(_ownerId, grant.SourceOwnerId);
        Assert.Equal("standup", grant.SourceNoteId);
        Assert.Equal("ping0001", grant.BlockId);
        Assert.Equal(_beaId, grant.GranteeUserId);
        Assert.Equal(Owner, grant.SourceUsername);
        Assert.Null(grant.DismissedUtc);
    }

    [Theory]
    [InlineData("../../../../evil")]
    [InlineData("..\\..\\..\\evil")]
    [InlineData("/etc/passwd")]
    [InlineData("....//....//evil")]
    [InlineData("..%2F..%2Fevil")]
    public async Task Delivery_CannotBeRedirectedByACraftedNoteId(string noteId)
    {
        Send(noteId, "Please look @bea. ^ping0001");
        await WaitForFileAsync(InboxOf(_beaId));
        await FenceAsync();

        // Still exactly two files: bea's inbox and the fence recipient's. Nothing
        // landed beside, above or outside the recipient vaults.
        Assert.Equal(Expect(_beaId, _calId), AllFiles());
        // The hostile id is inert content inside the reference line.
        Assert.Contains($"![[{noteId}#^ping0001]]", await File.ReadAllTextAsync(InboxOf(_beaId)));
    }

    [Fact]
    public async Task Delivery_ToAPathShapedUsername_StillLandsInThatUsersOwnVault()
    {
        Send("n1", $"Ping @{DottedName} here. ^ping0001");
        await WaitForFileAsync(InboxOf(_dottedId));
        await FenceAsync();

        // Routed by numeric id, so the dots in the name never reach the path.
        Assert.Equal(Expect(_dottedId, _calId), AllFiles());
    }

    [Fact]
    public async Task Delivery_MatchesTheUsernameCaseInsensitively_WithoutASecondVault()
    {
        Send("n1", "Ping @BEA loudly. ^ping0001");
        await WaitForFileAsync(InboxOf(_beaId));
        await FenceAsync();

        Assert.Equal(Expect(_beaId, _calId), AllFiles());
    }

    // ---- cases that must write nothing at all -------------------------------

    [Fact]
    public async Task Delivery_ToAnUnknownAccount_CreatesNothing()
    {
        Send("n1", "Hello @nobodyatall. ^ping0001");
        await FenceAsync();

        Assert.Equal(Expect(_calId), AllFiles());
    }

    [Fact]
    public async Task Delivery_FromAnUnanchoredBlock_CreatesNothing()
    {
        // A list item carries no anchor, so there is no single block to deliver —
        // and shipping the whole note instead is exactly what must not happen.
        Send("n1", "- ask @bea about it\n- something private");
        await FenceAsync();

        Assert.Equal(Expect(_calId), AllFiles());
        Assert.False(Directory.Exists(_vault.UserNotesDir(_beaId.ToString())));
    }

    [Fact]
    public async Task Delivery_OfASelfMention_NeverWritesTheSendersOwnVault()
    {
        Send("n1", $"Note to self @{Owner}. ^ping0001");
        await FenceAsync();

        Assert.Equal(Expect(_calId), AllFiles());
    }

    [Fact]
    public async Task Delivery_IgnoresAMentionThatWasAlreadyInThePriorRevision()
    {
        // Re-saving a note must not re-ping everyone named in it.
        Send("n1", "Ping @bea. ^ping0001 edited", priorBody: "Ping @bea. ^ping0001");
        await FenceAsync();

        Assert.Equal(Expect(_calId), AllFiles());
    }

    [Fact]
    public async Task Delivery_OfTheSameBlockTwice_AppendsOnlyOneEntry()
    {
        Send("standup", "Can @bea take this? ^ping0001");
        await WaitForFileAsync(InboxOf(_beaId));
        Send("standup", "Can @bea take this? ^ping0001");
        await FenceAsync();

        var entries = (await File.ReadAllTextAsync(InboxOf(_beaId)))
            .Split("![[").Length - 1;
        Assert.Equal(1, entries);

        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Equal(1, await db.BlockGrants.CountAsync(g => g.GranteeUserId == _beaId));
    }

    // ---- abuse limits -------------------------------------------------------

    [Fact]
    public async Task Delivery_StopsAtTheHourlyCapForOneSenderRecipientPair()
    {
        // Well past the cap, each a distinct note and block so nothing is
        // deduplicated by the already-granted check.
        var overCap = MentionDeliveryService.MaxDeliveriesPerSenderPerHour + 5;
        for (var i = 0; i < overCap; i++)
            Send($"spam{i}", $"Ping @bea number {i}. ^blk{i:0000}");
        await FenceAsync();

        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Equal(
            MentionDeliveryService.MaxDeliveriesPerSenderPerHour,
            await db.BlockGrants.CountAsync(g => g.GranteeUserId == _beaId));
    }

    [Fact]
    public async Task Delivery_ThrottlingOneSenderDoesNotSilenceAnother()
    {
        // The cap is per sender/recipient pair, so an abuser must not be able to
        // spend a third party's ability to reach the same person.
        var overCap = MentionDeliveryService.MaxDeliveriesPerSenderPerHour + 3;
        for (var i = 0; i < overCap; i++)
            Send($"spam{i}", $"Ping @bea number {i}. ^blk{i:0000}");

        // A different sender, same recipient.
        _svc.Enqueue(_calId.ToString(), "cal", "from-cal", "Genuine ping @bea. ^calblk01", null);
        await FenceAsync();

        using var scope = _sp.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.True(await db.BlockGrants.AnyAsync(
            g => g.GranteeUserId == _beaId && g.SourceOwnerId == _calId && g.BlockId == "calblk01"));
    }

    // ---- harness ------------------------------------------------------------

    private void Send(string noteId, string body, string? priorBody = null)
        => _svc.Enqueue(_ownerId.ToString(), Owner, noteId, body, priorBody);

    private string InboxOf(int userId) =>
        Path.Combine(_vault.UserNotesDir(userId.ToString()), $"{MentionDeliveryService.InboxNoteId}.md");

    // Every file under the users root, relative and slash-normalised, so a stray
    // write anywhere in the tree shows up in the assertion.
    private string[] AllFiles() =>
        Directory.GetFiles(_usersDir, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(_usersDir, p).Replace('\\', '/'))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToArray();

    private static string[] Expect(params int[] userIds) =>
        userIds.Select(id => $"{id}/notes/{MentionDeliveryService.InboxNoteId}.md")
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToArray();

    // The queue is FIFO and drained by a single worker, so a delivery we *do*
    // expect is a fence: once the fence recipient's inbox exists, every job queued
    // before it has already been processed. That makes the "wrote nothing"
    // assertions deterministic instead of a race against a sleep.
    private async Task FenceAsync()
    {
        Send("fence-note", "Fence for @cal. ^fence001");
        await WaitForFileAsync(InboxOf(_calId));
    }

    private static async Task WaitForFileAsync(string path, int timeoutMs = 10_000)
    {
        var sw = Stopwatch.StartNew();
        while (!File.Exists(path) && sw.ElapsedMilliseconds < timeoutMs) await Task.Delay(25);
        Assert.True(File.Exists(path), $"Timed out waiting for {path}");
    }
}
