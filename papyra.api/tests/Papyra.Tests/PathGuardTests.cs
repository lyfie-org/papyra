using System.Security;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class PathGuardTests
{
    private static readonly string Base =
        Path.Combine(Path.GetTempPath(), "papyra-jail", "users", "1", "notes");

    [Fact]
    public void PlainName_ResolvesInsideBase()
    {
        var resolved = PathGuard.ResolveAndVerify(Base, "n1.md");
        Assert.Equal(Path.Combine(Path.GetFullPath(Base), "n1.md"), resolved);
    }

    [Theory]
    [InlineData("../../2/notes/secret.md")] // climb into another tenant
    [InlineData("../../../etc/passwd")]      // climb out of the data root
    public void Traversal_Throws(string requested)
    {
        Assert.Throws<SecurityException>(() => PathGuard.ResolveAndVerify(Base, requested));
    }

    [Fact]
    public void SiblingPrefix_DoesNotLeak()
    {
        // ".../users/1/notes" must not let ".../users/10/..." through on a naive
        // StartsWith — the fence carries a trailing separator.
        var escape = Path.Combine("..", "..", "10", "notes", "x.md");
        Assert.Throws<SecurityException>(() => PathGuard.ResolveAndVerify(Base, escape));
    }
}
