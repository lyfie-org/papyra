using System.Security.Cryptography;
using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class EncryptedBackupServiceTests
{
    [Fact]
    public async Task Backup_Then_Restore_RoundTripsNotesAndMedia()
    {
        var src = NewTempDir();
        var dst = NewTempDir();
        try
        {
            var notes = Path.Combine(src, "notes");
            var media = Path.Combine(src, "media");
            Directory.CreateDirectory(Path.Combine(notes, "sub"));
            Directory.CreateDirectory(media);
            const string aBody = "---\nid: a1\n---\nhello";
            await File.WriteAllTextAsync(Path.Combine(notes, "a.md"), aBody);
            await File.WriteAllTextAsync(Path.Combine(notes, "sub", "b.md"), "nested");
            await File.WriteAllBytesAsync(Path.Combine(media, "pic.bin"), [1, 2, 3, 4, 5]);

            var svc = new EncryptedBackupService();
            using var vault = new MemoryStream();
            await svc.BackupAsync([("notes", notes), ("media", media)], "s3cret", vault, default);

            vault.Position = 0;
            await svc.RestoreAsync(vault, "s3cret", dst, default);

            Assert.Equal(aBody, await File.ReadAllTextAsync(Path.Combine(dst, "notes", "a.md")));
            Assert.Equal("nested", await File.ReadAllTextAsync(Path.Combine(dst, "notes", "sub", "b.md")));
            Assert.Equal([1, 2, 3, 4, 5], await File.ReadAllBytesAsync(Path.Combine(dst, "media", "pic.bin")));
        }
        finally { CleanUp(src, dst); }
    }

    [Fact]
    public async Task Restore_WithWrongPassword_Throws()
    {
        var src = NewTempDir();
        var dst = NewTempDir();
        try
        {
            var notes = Path.Combine(src, "notes");
            Directory.CreateDirectory(notes);
            await File.WriteAllTextAsync(Path.Combine(notes, "a.md"), "secret body");

            var svc = new EncryptedBackupService();
            using var vault = new MemoryStream();
            await svc.BackupAsync([("notes", notes)], "right-password", vault, default);

            vault.Position = 0;
            await Assert.ThrowsAsync<AuthenticationTagMismatchException>(
                () => svc.RestoreAsync(vault, "wrong-password", dst, default));
        }
        finally { CleanUp(src, dst); }
    }

    [Fact]
    public async Task Restore_OnNonVaultFile_ThrowsInvalidData()
    {
        var dst = NewTempDir();
        try
        {
            using var garbage = new MemoryStream("not a papyra vault at all"u8.ToArray());
            await Assert.ThrowsAsync<InvalidDataException>(
                () => new EncryptedBackupService().RestoreAsync(garbage, "x", dst, default));
        }
        finally { CleanUp(dst); }
    }

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"papyra-backup-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static void CleanUp(params string[] dirs)
    {
        foreach (var d in dirs)
            if (Directory.Exists(d)) Directory.Delete(d, recursive: true);
    }
}
