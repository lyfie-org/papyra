using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class UnlockTokenStoreTests
{
    [Fact]
    public void IssuedToken_IsValidForItsOwner()
    {
        var store = new UnlockTokenStore();
        var token = store.Issue("1");
        Assert.True(store.IsValid(token, "1"));
    }

    [Fact]
    public void Token_DoesNotUnlockAnotherTenant()
    {
        var store = new UnlockTokenStore();
        var alice = store.Issue("1");
        Assert.False(store.IsValid(alice, "2")); // cross-tenant unlock must fail
    }

    [Fact]
    public void UnknownOrEmptyToken_IsRejected()
    {
        var store = new UnlockTokenStore();
        Assert.False(store.IsValid("not-a-real-token", "1"));
        Assert.False(store.IsValid("", "1"));
        Assert.False(store.IsValid(null, "1"));
    }

    [Fact]
    public void RevokedToken_StopsWorking()
    {
        var store = new UnlockTokenStore();
        var token = store.Issue("1");
        store.Revoke(token);
        Assert.False(store.IsValid(token, "1"));
    }

    [Fact]
    public void EachIssue_MintsADistinctToken()
    {
        var store = new UnlockTokenStore();
        Assert.NotEqual(store.Issue("1"), store.Issue("1"));
    }
}
