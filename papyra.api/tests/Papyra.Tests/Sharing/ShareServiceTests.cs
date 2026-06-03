using Microsoft.Extensions.Configuration;
using Papyra.Api.Models;
using Papyra.Api.Services;

namespace Papyra.Tests.Sharing;

public sealed class ShareServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    private readonly ShareService _sut;

    public ShareServiceTests()
    {
        Directory.CreateDirectory(_root);
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:StorageRoot"] = _root })
            .Build();
        _sut = new ShareService(config);
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private ShareRecord MakeRecord(string noteId, string grantee, string permission = "read", DateTime? expiresAt = null) =>
        new()
        {
            ShareId    = Guid.NewGuid().ToString(),
            NoteId     = noteId,
            OwnerId    = "alice",
            Grantee    = grantee,
            Permission = permission,
            ExpiresAt  = expiresAt,
        };

    // ── Create / Get / Delete ─────────────────────────────────────────────────

    [Fact]
    public async Task Create_ThenGetSharesForNote_ReturnsRecord()
    {
        var r = MakeRecord("note1", "bob");
        await _sut.CreateAsync(r);
        Assert.Single(_sut.GetSharesForNote("note1"));
    }

    [Fact]
    public async Task Delete_RemovesFromIndex()
    {
        var r = MakeRecord("note1", "bob");
        await _sut.CreateAsync(r);
        await _sut.DeleteAsync(r.ShareId);
        Assert.Empty(_sut.GetSharesForNote("note1"));
    }

    [Fact]
    public async Task GetSharesForGrantee_ReturnsMine_NotOthers()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob"));
        await _sut.CreateAsync(MakeRecord("note2", "carol"));
        var mine = _sut.GetSharesForGrantee("bob").ToList();
        Assert.Single(mine);
        Assert.Equal("note1", mine[0].NoteId);
    }

    // ── Permission checks ────────────────────────────────────────────────────

    [Fact]
    public async Task IsGranted_TrueForGrantee_FalseForOther()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob"));
        Assert.True(_sut.IsGranted("note1", "bob"));
        Assert.False(_sut.IsGranted("note1", "carol"));
    }

    [Fact]
    public async Task IsWriteGranted_ReadShare_ReturnsFalse()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob", "read"));
        Assert.False(_sut.IsWriteGranted("note1", "bob"));
    }

    [Fact]
    public async Task IsWriteGranted_WriteShare_ReturnsTrue()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob", "write"));
        Assert.True(_sut.IsWriteGranted("note1", "bob"));
    }

    [Fact]
    public async Task ExpiredShare_NotGranted()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob", expiresAt: DateTime.UtcNow.AddDays(-1)));
        Assert.False(_sut.IsGranted("note1", "bob"));
    }

    [Fact]
    public async Task FutureExpiry_IsGranted()
    {
        await _sut.CreateAsync(MakeRecord("note1", "bob", expiresAt: DateTime.UtcNow.AddDays(30)));
        Assert.True(_sut.IsGranted("note1", "bob"));
    }

    // ── Public token ─────────────────────────────────────────────────────────

    [Fact]
    public void GeneratePublicToken_ProducesNonEmpty()
    {
        var token = _sut.GeneratePublicToken(Guid.NewGuid().ToString(), DateTime.UtcNow.AddDays(7));
        Assert.NotEmpty(token);
        Assert.Contains(".", token);
    }

    [Fact]
    public async Task ValidatePublicToken_ValidToken_ReturnsRecord()
    {
        var shareId = Guid.NewGuid().ToString();
        var expiry  = DateTime.UtcNow.AddDays(7);
        var token   = _sut.GeneratePublicToken(shareId, expiry);

        var r = new ShareRecord
        {
            ShareId     = shareId,
            NoteId      = "note1",
            OwnerId     = "alice",
            Permission  = "read",
            ExpiresAt   = expiry,
            PublicToken = token,
        };
        await _sut.CreateAsync(r);

        var result = _sut.ValidatePublicToken(token);
        Assert.NotNull(result);
        Assert.Equal("note1", result.NoteId);
    }

    [Fact]
    public async Task ValidatePublicToken_TamperedSignature_ReturnsNull()
    {
        var shareId = Guid.NewGuid().ToString();
        var expiry  = DateTime.UtcNow.AddDays(7);
        var token   = _sut.GeneratePublicToken(shareId, expiry);

        var r = new ShareRecord
        {
            ShareId     = shareId,
            NoteId      = "note1",
            OwnerId     = "alice",
            Permission  = "read",
            ExpiresAt   = expiry,
            PublicToken = token,
        };
        await _sut.CreateAsync(r);

        // Flip the last char of the signature segment
        var dot     = token.IndexOf('.');
        var tampered = token[..dot] + "." + token[(dot + 1)..^1] + (token[^1] == 'A' ? 'B' : 'A');
        Assert.Null(_sut.ValidatePublicToken(tampered));
    }

    [Fact]
    public void ValidatePublicToken_ExpiredToken_ReturnsNull()
    {
        var shareId = Guid.NewGuid().ToString();
        // Create a token with a past expiry
        var token = _sut.GeneratePublicToken(shareId, DateTime.UtcNow.AddDays(-1));
        Assert.Null(_sut.ValidatePublicToken(token));
    }

    [Fact]
    public void ValidatePublicToken_MalformedToken_ReturnsNull()
    {
        Assert.Null(_sut.ValidatePublicToken("not-a-real-token"));
        Assert.Null(_sut.ValidatePublicToken(""));
        Assert.Null(_sut.ValidatePublicToken("abc.def.ghi")); // too many segments
    }
}
