using System.Text;
using Papyra.Api.Storage;

namespace Papyra.Tests;

/// <summary>
/// Hostile and random input for the code that reads what uploads and note
/// bodies say about attachments. Each runs on every upload, import, save and
/// media request: an exception here is a 500 (or a failed import) a person can
/// trigger. Seeded, so a failure reproduces.
/// </summary>
public sealed class MediaFuzzTests
{
    // PAPYRA_FUZZ_SEED=n runs another sequence (a failure prints its input).
    private static readonly int Seed = int.TryParse(Environment.GetEnvironmentVariable("PAPYRA_FUZZ_SEED"), out var s) ? s : 20261001;

    private static readonly string[] Pieces =
    [
        "![[", "[[", "]]", "|", "\\|", "#", "^", "#page=3", "|300", "|640x360", "|Alt text|", "![", "](", ")", "<", ">",
        "/api/media/", "/api/shared/tok/media/", "/api/shares/incoming/4/media/", "photo.png", "Photo.PNG", "a b.jpg",
        "sub/", "..", "../", "%20", "%", "%zz", "youtube:", "https://", "card:", "iframe:", "<img src=\"", "\"",
        "'", " ", "\n", "\r\n", "\t", "<!-- align:center -->", "\u0000", "é", "😀", "\u202e", "[", "]", "(", "!",
    ];

    private static string RandomBody(Random rng)
    {
        var sb = new StringBuilder();
        var n = rng.Next(0, 40);
        for (var i = 0; i < n; i++)
        {
            if (rng.Next(4) == 0) sb.Append((char)rng.Next(0, 0x3000));
            else sb.Append(Pieces[rng.Next(Pieces.Length)]);
        }
        return sb.ToString();
    }

    [Fact]
    public void Sniffer_NeverThrows_OnRandomOrTruncatedBytes()
    {
        var rng = new Random(Seed);
        string[] names = ["a.png", "b.jpg", "c.mp4", "d.pdf", "e.docx", "f", ".", "x.html", "y.svg", "z.heic", "w.txt", ""];
        // Real signatures, cut short at every length — the classic way to trip a parser.
        byte[][] heads =
        [
            [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], [0xFF, 0xD8, 0xFF, 0xE0], "GIF89a"u8.ToArray(),
            "RIFF\0\0\0\0WEBP"u8.ToArray(), [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
            [0x1A, 0x45, 0xDF, 0xA3], "%PDF-1.7"u8.ToArray(), [0x50, 0x4B, 0x03, 0x04], [0xD0, 0xCF, 0x11, 0xE0],
            "<?xml version=\"1.0\"?><svg"u8.ToArray(), [0xEF, 0xBB, 0xBF], "OggS"u8.ToArray(), "fLaC"u8.ToArray(),
        ];
        foreach (var head in heads)
            for (var len = 0; len <= head.Length; len++)
                foreach (var name in names)
                    AssertSniffs(head.AsSpan(0, len).ToArray(), name);

        for (var i = 0; i < 5000; i++)
        {
            var bytes = new byte[rng.Next(0, 9000)];
            rng.NextBytes(bytes);
            if (rng.Next(3) == 0)
            {
                // A real signature followed by garbage.
                var h = heads[rng.Next(heads.Length)];
                h.AsSpan(0, Math.Min(h.Length, bytes.Length)).CopyTo(bytes);
            }
            AssertSniffs(bytes, names[rng.Next(names.Length)]);
        }
    }

    private static void AssertSniffs(byte[] head, string name)
    {
        var sniffed = MediaSniffer.Sniff(head, name);
        Assert.False(string.IsNullOrEmpty(sniffed.Kind));
        Assert.StartsWith(".", sniffed.Extension);
        // Whatever the name claims, an active-content extension never comes back.
        Assert.DoesNotContain(sniffed.Extension, (string[])[".html", ".htm", ".js", ".xml", ".xhtml", ".svgz"]);
    }

    [Fact]
    public void RefParser_NeverThrows_AndOnlyYieldsSafeNames()
    {
        var rng = new Random(Seed);
        for (var i = 0; i < 20_000; i++)
        {
            var body = RandomBody(rng);
            var names = MediaRefParser.Extract(body);
            foreach (var name in names)
            {
                Assert.InRange(name.Length, 1, 255);
                Assert.DoesNotContain('/', name);
                Assert.DoesNotContain('\\', name);
                Assert.NotEqual("..", name);
                Assert.NotEqual(".", name);
            }
        }
    }

    [Fact]
    public void Rename_NeverThrows_IsIdentityWithoutAMatch_AndMovesTheReference()
    {
        var rng = new Random(Seed);
        var none = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["no-such-file-q9.png"] = "x.png" };
        var renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["photo.png"] = "photo-2.png" };
        for (var i = 0; i < 20_000; i++)
        {
            var body = RandomBody(rng);
            Assert.Equal(body, MediaRefParser.Rename(body, none));
            var renamed = MediaRefParser.Rename(body, renames);
            // After renaming, the old name is never referenced and nothing else changed name.
            var before = MediaRefParser.Extract(body);
            var after = MediaRefParser.Extract(renamed);
            Assert.False(after.Contains("photo.png"), $"still references photo.png after renaming: {body} => {renamed}");
            // ...and the new one is there wherever the old one was. (Whether
            // *other* references stay put is checked on well-formed bodies in
            // MediaJobsTests: in random junk, rewriting one overlapping form can
            // move where another malformed one starts.)
            if (before.Contains("photo.png"))
                Assert.True(after.Contains("photo-2.png"), $"lost the reference renaming: {body} => {renamed}");
        }
    }
}
