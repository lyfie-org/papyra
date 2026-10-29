using System.Text;
using Papyra.Api.Storage;
using SkiaSharp;

namespace Papyra.Tests;

/// <summary>How the journal book sets what a day holds.</summary>
public sealed class JournalPdfTests
{
    private static string Pdf(string body, Func<string, BookMedia?>? media = null)
    {
        using var ms = new MemoryStream();
        JournalPdf.Write(ms, [new BookDay(new DateOnly(2026, 10, 27), 4, body)], "Journal", "Someone", media ?? (_ => null));
        return Encoding.Latin1.GetString(ms.ToArray());
    }

    [Fact]
    public void ALineIndentedByATabOrFourSpaces_IsAParagraph_NotACodeBlock()
    {
        // The editor's indent writes leading spaces; to Markdown that is "code", which printed in a monospace face.
        Assert.DoesNotContain("RobotoMono", Pdf("    I wish I could pull developers in to talk about other things.\n\n\tOh also, the developer."));
    }

    [Fact]
    public void CodeThatIsFenced_IsStillSetInTheMonospaceFace()
    {
        Assert.Contains("RobotoMono", Pdf("```\nconst a = 1;\n```"));
        Assert.Contains("RobotoMono", Pdf("a `snippet` inline"));
    }

    [Fact]
    public void TheEditorsComments_NeverReachThePage_AndACaptionIsKept()
    {
        var text = JournalPdf.Prepare("Before\n\n![[voice-2026-10-29-1400-bd21fa.weba]] <!-- align:right --> <!-- caption:This is a caption -->\n\n<!-- a stray note --> After");
        Assert.DoesNotContain("<!--", text);
        Assert.DoesNotContain("align", text);
        Assert.DoesNotContain("Attachment:", text);
        var marker = text.Split('\n').Single(l => l.StartsWith("![](papyra-embed:"));
        var spec = JournalPdf.Decode(marker[4..^1])!;
        Assert.Equal("voice-2026-10-29-1400-bd21fa.weba", spec.Target);
        Assert.Equal("This is a caption", spec.Caption);
        Assert.Contains("After", text);
    }

    [Theory]
    [InlineData("![[iframe:https://www.youtube.com/embed/abc|640x400]] <!-- align:left -->", "Iframe", "https://www.youtube.com/embed/abc", null, null)]
    [InlineData("![[card:https://example.com/post|Example post|480]] <!-- caption:Worth a read -->", "Card", "https://example.com/post", "Example post", "Worth a read")]
    [InlineData("![[q3.pdf|Q3 report]]", "File", "q3.pdf", "Q3 report", null)]
    [InlineData("![[beach.jpg|640]] <!-- align:center --> <!-- caption:At dusk -->", "File", "beach.jpg", null, "At dusk")]
    [InlineData("![A gif|240](https://media.example.com/party.gif) <!-- align:right -->", "Remote", "https://media.example.com/party.gif", "A gif", null)]
    public void EveryKindOfEmbed_BecomesOneMarkerWithItsTitleAndCaption(string line, string kind, string target, string? title, string? caption)
    {
        var markers = JournalPdf.Prepare(line).Split('\n').Where(l => l.StartsWith("![](papyra-embed:")).ToList();
        var spec = JournalPdf.Decode(Assert.Single(markers)[4..^1])!;
        Assert.Equal(kind, spec.Kind.ToString());
        Assert.Equal(target, spec.Target);
        Assert.Equal(title, spec.Title);
        Assert.Equal(caption, spec.Caption);
    }

    [Fact]
    public void ANoteOrAChecklistEmbed_StaysWords()
    {
        var text = JournalPdf.Prepare("![[Groceries#^checklist]]\n\n![[Kyoto trip]]");
        Assert.Contains("*Groceries (checklist)*", text);
        Assert.Contains("*Kyoto trip*", text);
        Assert.DoesNotContain("papyra-embed", text);
    }

    [Fact]
    public void LengthsAndVoiceNamesReadAsTheyDoOnThePage()
    {
        Assert.Equal("0:46", JournalPdf.Clock(46_000));
        Assert.Equal("12:03", JournalPdf.Clock(723_000));
        Assert.Equal("1:02:07", JournalPdf.Clock(3_727_000));
        Assert.Equal("Voice note · 2:00 pm", JournalPdf.VoiceTitle("voice-2026-10-29-1400-bd21fa.weba"));
        Assert.Equal("Voice note · 9:05 am", JournalPdf.VoiceTitle("voice-2026-10-29-0905-ab12cd.wav"));
        Assert.Equal("walk.m4a", JournalPdf.VoiceTitle("walk.m4a"));
    }

    [Fact]
    public void ARecordingsLengthIsReadFromItsWavHeader()
    {
        var path = Path.Combine(Path.GetTempPath(), "papyra-wav-" + Guid.NewGuid().ToString("N") + ".wav");
        try
        {
            var data = new byte[16000 * 2 * 46]; // 46 s of 16 kHz mono 16-bit
            using (var fs = File.Create(path))
            using (var w = new BinaryWriter(fs))
            {
                w.Write("RIFF"u8); w.Write(36 + data.Length); w.Write("WAVE"u8); w.Write("fmt "u8); w.Write(16);
                w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
                w.Write("data"u8); w.Write(data.Length); w.Write(data);
            }
            Assert.Equal(46_000, JournalPdf.WavDurationMs(path));
            File.WriteAllBytes(path, [1, 2, 3]);
            Assert.Null(JournalPdf.WavDurationMs(path));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void EveryKindOfAttachment_ShowsAsACardOrAPicture_NotAsBookkeeping()
    {
        var dir = Path.Combine(Path.GetTempPath(), "papyra-embeds-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string Png(string name)
            {
                var path = Path.Combine(dir, name);
                using var bmp = new SKBitmap(64, 36);
                using var img = SKImage.FromBitmap(bmp);
                using var fs = File.Create(path);
                img.Encode(SKEncodedImageFormat.Png, 90).SaveTo(fs);
                return path;
            }
            var poster = Png("clip.poster.png");
            var picture = Png("beach.png");
            File.WriteAllBytes(Path.Combine(dir, "voice-2026-10-29-1400-bd21fa.weba"), new byte[10]);
            File.WriteAllBytes(Path.Combine(dir, "q3.pdf"), new byte[2000]);
            BookMedia? Resolve(string name) => name switch
            {
                "clip.mp4" => new BookMedia(Path.Combine(dir, "clip.mp4"), 1000, 12_000, poster),
                "beach.png" => new BookMedia(picture, 100, null, null),
                _ when File.Exists(Path.Combine(dir, name)) => new BookMedia(Path.Combine(dir, name), new FileInfo(Path.Combine(dir, name)).Length, null, null),
                _ => null,
            };
            var body = string.Join("\n\n",
                "![[beach.png|640]] <!-- caption:At dusk -->", "![[voice-2026-10-29-1400-bd21fa.weba]] <!-- align:right -->",
                "![[clip.mp4]]", "![[iframe:https://www.youtube.com/embed/abc]]", "![[card:https://example.com/p|A post]]",
                "![[q3.pdf|Q3 report]]", "![[missing.mp3]]", "![x](https://example.com/a.gif)");
            var pdf = Pdf(body, Resolve);
            Assert.StartsWith("%PDF-", pdf);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
