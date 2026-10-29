using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace Papyra.Api.Storage;

/// <summary>What the book can learn about an attachment: where it is, how big, how long, and its video poster.</summary>
public sealed record BookMedia(string Path, long Size, long? DurationMs, string? PosterPath);

/// <summary>
/// How the book sets what a page can't show: a picture is drawn, and anything else is drawn as the small card it
/// is on the page — a voice note as a mini player with its name and length, a video as its poster with a play
/// button, a map, a page or a document as a card saying what it is and where it points. A caption goes under it.
/// The editor's own bookkeeping (<c>&lt;!-- align:… --&gt;</c>) never reaches the page.
/// </summary>
public static partial class JournalPdf
{
    internal enum EmbedKind { File, Iframe, Card, Remote }

    /// <summary>One attachment or embed in a day: <c>Target</c> is a file name or an address.</summary>
    internal sealed record EmbedSpec(EmbedKind Kind, string Target, string? Title, string? Caption);

    private const string EmbedScheme = "papyra-embed:";

    [GeneratedRegex(@"!\[\[(?<inner>[^\]\r\n]+)\]\](?<tail>(?:[ \t]*<!--.*?-->)*)")]
    private static partial Regex EmbedLineRx();

    [GeneratedRegex(@"!\[(?<alt>[^\]\r\n]*)\]\((?<url>(?!papyra-embed:)[^)\s]+)(?:\s+""[^""]*"")?\)(?<tail>(?:[ \t]*<!--.*?-->)*)")]
    private static partial Regex MarkdownImageRx();

    [GeneratedRegex(@"<!--(?<c>.*?)-->")]
    private static partial Regex CommentRx();

    [GeneratedRegex(@"caption:(?<t>.*?)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex CaptionRx();

    [GeneratedRegex(@"^\d+(x\d+)?$")]
    private static partial Regex SizeRx();

    [GeneratedRegex(@"^voice-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-", RegexOptions.IgnoreCase)]
    private static partial Regex VoiceNameRx();

    private static readonly HashSet<string> AudioTypes = new(StringComparer.OrdinalIgnoreCase)
        { ".weba", ".wav", ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".aac", ".webm" };

    private static readonly HashSet<string> VideoTypes = new(StringComparer.OrdinalIgnoreCase)
        { ".mp4", ".m4v", ".mov", ".mkv", ".avi", ".ogv" };

    // host → (what to call it, the card's glyph)
    private enum Glyph { Play, Music, Pin, Page, Picture, Document }

    private static readonly (string Host, string Label, Glyph Glyph)[] Providers =
    [
        ("youtube.com", "YouTube video", Glyph.Play), ("youtu.be", "YouTube video", Glyph.Play),
        ("youtube-nocookie.com", "YouTube video", Glyph.Play), ("vimeo.com", "Vimeo video", Glyph.Play),
        ("loom.com", "Loom video", Glyph.Play), ("dailymotion.com", "Dailymotion video", Glyph.Play),
        ("tiktok.com", "TikTok video", Glyph.Play), ("twitch.tv", "Twitch video", Glyph.Play),
        ("spotify.com", "Spotify", Glyph.Music), ("soundcloud.com", "SoundCloud", Glyph.Music),
        ("openstreetmap.org", "Map", Glyph.Pin), ("maps.google.com", "Google Map", Glyph.Pin),
        ("maps.app.goo.gl", "Google Map", Glyph.Pin), ("goo.gl", "Google Map", Glyph.Pin),
        ("docs.google.com", "Google Doc", Glyph.Document), ("drive.google.com", "Google Drive file", Glyph.Document),
        ("figma.com", "Figma file", Glyph.Page), ("miro.com", "Miro board", Glyph.Page), ("canva.com", "Canva design", Glyph.Page),
    ];

    // ── Reading a day's Markdown ─────────────────────────────────────────────

    internal static string Encode(EmbedSpec spec) =>
        EmbedScheme + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new[] { spec.Kind.ToString(), spec.Target, spec.Title ?? "", spec.Caption ?? "" }))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    internal static EmbedSpec? Decode(string url)
    {
        if (!url.StartsWith(EmbedScheme, StringComparison.Ordinal)) return null;
        try
        {
            var b64 = url[EmbedScheme.Length..].Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            var parts = JsonSerializer.Deserialize<string[]>(Convert.FromBase64String(b64));
            if (parts is not { Length: 4 } || !Enum.TryParse<EmbedKind>(parts[0], out var kind)) return null;
            return new EmbedSpec(kind, parts[1], parts[2].Length > 0 ? parts[2] : null, parts[3].Length > 0 ? parts[3] : null);
        }
        catch (Exception) { return null; }
    }

    private static string? CaptionOf(string tail)
    {
        foreach (Match m in CommentRx().Matches(tail))
            if (CaptionRx().Match(m.Groups["c"].Value.Trim()) is { Success: true } c && c.Groups["t"].Value.Length > 0)
                return c.Groups["t"].Value;
        return null;
    }

    private static string Block(EmbedSpec spec) => $"\n\n![]({Encode(spec)})\n\n";

    /// <summary>A day's Markdown made ready for the page: embeds become markers, the editor's comments are gone.</summary>
    internal static string Prepare(string body)
    {
        var text = BlockResolver.StripAnchors(body ?? string.Empty, new HashSet<string>(StringComparer.Ordinal));
        text = EmbedLineRx().Replace(text, m =>
        {
            var parts = m.Groups["inner"].Value.Split('|');
            var target = parts[0].Trim();
            var caption = CaptionOf(m.Groups["tail"].Value);
            if (target.StartsWith("iframe:", StringComparison.OrdinalIgnoreCase))
                return Block(new EmbedSpec(EmbedKind.Iframe, target["iframe:".Length..].Trim(), null, caption));
            if (target.StartsWith("card:", StringComparison.OrdinalIgnoreCase))
            {
                var title = parts.Length > 1 && !SizeRx().IsMatch(parts[1].Trim()) ? parts[1].Trim() : null;
                return Block(new EmbedSpec(EmbedKind.Card, target["card:".Length..].Trim(), title, caption));
            }
            var hash = target.IndexOf('#');
            var name = hash >= 0 ? target[..hash] : target;
            var frag = hash >= 0 ? target[(hash + 1)..] : string.Empty;
            if (frag.StartsWith('^') && frag.Contains("checklist", StringComparison.OrdinalIgnoreCase)) return $"*{name} (checklist)*";
            if (Path.GetExtension(name).Length == 0) return $"*{name}*"; // another note, embedded
            var alias = parts.Length > 1 && !SizeRx().IsMatch(parts[1].Trim()) ? parts[1].Trim() : null;
            return Block(new EmbedSpec(EmbedKind.File, name, alias, caption));
        });
        // A picture from a link: the book never goes out to fetch it — it shows what it points at.
        text = MarkdownImageRx().Replace(text, m =>
        {
            var alt = Regex.Replace(m.Groups["alt"].Value, @"\|\d+(x\d+)?$", string.Empty).Trim();
            return Block(new EmbedSpec(EmbedKind.Remote, m.Groups["url"].Value, alt.Length > 0 ? alt : null, CaptionOf(m.Groups["tail"].Value)));
        });
        text = CommentRx().Replace(text, string.Empty);
        return WikiRx().Replace(text, m => m.Groups["a"].Success && m.Groups["a"].Value.Length > 0
            ? m.Groups["a"].Value : m.Groups["t"].Value.Trim());
    }

    // ── What an embed is, in words ───────────────────────────────────────────

    private static string? HostOf(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" ? u.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? u.Host[4..] : u.Host : null;

    private static (string Label, Glyph Glyph) Describe(string url, string fallback)
    {
        var host = HostOf(url);
        if (host is null) return (fallback, Glyph.Page);
        foreach (var (h, label, glyph) in Providers)
        {
            if (!host.Equals(h, StringComparison.OrdinalIgnoreCase) && !host.EndsWith("." + h, StringComparison.OrdinalIgnoreCase)) continue;
            // google.com/maps is a map; docs, drive and the rest of google.com are not.
            return (label, glyph);
        }
        if (host.Contains("google.", StringComparison.OrdinalIgnoreCase) && url.Contains("/maps", StringComparison.OrdinalIgnoreCase)) return ("Google Map", Glyph.Pin);
        return (fallback, Glyph.Page);
    }

    /// <summary>"0:46", "12:03", "1:02:07".</summary>
    internal static string Clock(long ms)
    {
        var s = (int)Math.Max(0, Math.Round(ms / 1000.0));
        return s >= 3600 ? $"{s / 3600}:{s % 3600 / 60:00}:{s % 60:00}" : $"{s / 60}:{s % 60:00}";
    }

    /// <summary>A recording's length from a PCM WAV header (what a voice note is, when the server transcribes).</summary>
    internal static long? WavDurationMs(string path)
    {
        try
        {
            using var f = File.OpenRead(path);
            Span<byte> head = stackalloc byte[12];
            if (f.Read(head) < 12 || !head[..4].SequenceEqual("RIFF"u8) || !head[8..12].SequenceEqual("WAVE"u8)) return null;
            long byteRate = 0;
            Span<byte> chunk = stackalloc byte[8];
            while (f.Read(chunk) == 8)
            {
                var id = Encoding.ASCII.GetString(chunk[..4]);
                var size = BitConverter.ToUInt32(chunk[4..8]);
                if (id == "fmt ")
                {
                    Span<byte> fmt = stackalloc byte[16];
                    if (f.Read(fmt) < 16) return null;
                    byteRate = BitConverter.ToUInt32(fmt[8..12]);
                    f.Seek(size - 16 + (size & 1), SeekOrigin.Current);
                }
                else if (id == "data")
                    return byteRate > 0 ? (long)(Math.Min(size, f.Length - f.Position) * 1000.0 / byteRate) : null;
                else f.Seek(size + (size & 1), SeekOrigin.Current);
            }
        }
        catch (Exception) { /* unreadable: no length */ }
        return null;
    }

    /// <summary>"Voice note · 2:00 pm" for the file name the recorder gives, else the name.</summary>
    internal static string VoiceTitle(string fileName)
    {
        var m = VoiceNameRx().Match(fileName);
        if (!m.Success) return fileName;
        var when = new DateTime(2000, 1, 1, int.Parse(m.Groups[4].Value), int.Parse(m.Groups[5].Value), 0);
        return "Voice note · " + when.ToString("h:mm tt", CultureInfo.InvariantCulture).ToLowerInvariant();
    }

    private static string Size(long bytes) => bytes switch
    {
        >= 1_048_576 => $"{bytes / 1_048_576.0:0.#} MB",
        >= 1024 => $"{Math.Max(1, bytes / 1024)} KB",
        > 0 => $"{bytes} B",
        _ => string.Empty,
    };

    private sealed partial class Book
    {
        // ── Setting an embed ─────────────────────────────────────────────────

        private void Embed(EmbedSpec spec, float indent, float width)
        {
            var media = spec.Kind == EmbedKind.File ? _media(spec.Target) : null;
            var ext = spec.Kind == EmbedKind.File ? Path.GetExtension(spec.Target) : string.Empty;

            if (spec.Kind == EmbedKind.File && PictureTypes.Contains(ext) && media is not null && ImageProcessor.CanDecode(media.Path)
                && ImageProcessor.Probe(media.Path) is { } probe)
            {
                Picture(media.Path, probe, spec.Caption, indent, width);
                return;
            }

            var name = spec.Kind == EmbedKind.File ? spec.Target : string.Empty;
            switch (spec.Kind)
            {
                case EmbedKind.File when AudioTypes.Contains(ext):
                {
                    var ms = media?.DurationMs ?? (media is not null && ext.Equals(".wav", StringComparison.OrdinalIgnoreCase) ? WavDurationMs(media.Path) : null);
                    VoiceCard(spec.Title ?? VoiceTitle(name), ms, spec.Caption, indent, width);
                    break;
                }
                case EmbedKind.File when VideoTypes.Contains(ext):
                    VideoCard(media, spec.Title ?? name, spec.Caption, indent, width);
                    break;
                case EmbedKind.File when PictureTypes.Contains(ext):
                    InfoCard(Glyph.Picture, spec.Title ?? name, media is null ? "Picture · missing" : "Picture", spec.Caption, indent, width);
                    break;
                case EmbedKind.File:
                {
                    var type = ext.Length > 1 ? ext[1..].ToUpperInvariant() : "File";
                    InfoCard(Glyph.Document, spec.Title ?? name, media is null ? $"{type} · missing" : string.Join(" · ", new[] { type, Size(media.Size) }.Where(s => s.Length > 0)), spec.Caption, indent, width);
                    break;
                }
                case EmbedKind.Iframe:
                {
                    var (label, glyph) = Describe(spec.Target, "Embedded page");
                    InfoCard(glyph, label, HostOf(spec.Target) ?? spec.Target, spec.Caption, indent, width);
                    break;
                }
                case EmbedKind.Card:
                {
                    var (label, glyph) = Describe(spec.Target, "Link");
                    InfoCard(glyph, spec.Title ?? label, HostOf(spec.Target) ?? spec.Target, spec.Caption, indent, width);
                    break;
                }
                default:
                    InfoCard(Glyph.Picture, spec.Title ?? "Picture", HostOf(spec.Target) ?? "Picture from a link", spec.Caption, indent, width);
                    break;
            }
        }

        // A card of its own height, centred in the column, with the caption set under it.
        private void CardBox(float height, float cardWidth, string? caption, float indent, float width, Action<SKCanvas, float, float, float> draw)
        {
            var w = Math.Min(cardWidth, width);
            Need(height + 12);
            var x = ML + indent + (width - w) / 2;
            var y = _y + 2;
            _ops.Add(c => draw(c, x, y, w));
            _y += height + 8;
            Caption(caption, indent + (width - w) / 2, w);
        }

        private void Caption(string? caption, float indent, float width)
        {
            if (string.IsNullOrWhiteSpace(caption)) { _y += 2; return; }
            var style = new Style(Face.Body, 8.2f, true, Soft, 12);
            SetWords(Words([new TextRun(caption.Trim(), style)]), indent, width, style, center: true);
            _y += 6;
        }

        private static void RoundedCard(SKCanvas c, float x, float y, float w, float h)
        {
            using var fill = new SKPaint { IsAntialias = true, Color = Wash };
            using var edge = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 0.6f, Color = new SKColor(0xe2, 0xd8, 0xca) };
            c.DrawRoundRect(x, y, w, h, 6, 6, fill);
            c.DrawRoundRect(x, y, w, h, 6, 6, edge);
        }

        private static void PlayTriangle(SKCanvas c, float cx, float cy, float size, SKColor color)
        {
            using var path = new SKPath();
            path.MoveTo(cx - size * 0.38f, cy - size * 0.5f);
            path.LineTo(cx + size * 0.55f, cy);
            path.LineTo(cx - size * 0.38f, cy + size * 0.5f);
            path.Close();
            using var paint = new SKPaint { IsAntialias = true, Color = color };
            c.DrawPath(path, paint);
        }

        // Text clipped to a width with an ellipsis, drawn in the face (and any fallback) it needs.
        private string Fit(string text, Style style, float max)
        {
            float WidthOf(string t) => Segments(t, style).Sum(s => s.Width);
            if (WidthOf(text) <= max) return text;
            var runes = text.EnumerateRunes().Select(r => r.ToString()).ToList();
            while (runes.Count > 1 && WidthOf(string.Concat(runes) + "…") > max) runes.RemoveAt(runes.Count - 1);
            return string.Concat(runes).TrimEnd() + "…";
        }

        private void DrawFitted(SKCanvas c, string text, Style style, float x, float baseline, float max)
        {
            var word = new Word();
            word.Segs.AddRange(Segments(Fit(text, style, max), style));
            DrawLine(c, [word], x, baseline);
        }

        // ── The cards ────────────────────────────────────────────────────────

        private void VoiceCard(string title, long? durationMs, string? caption, float indent, float width)
        {
            var titleStyle = new Style(Face.Semi, 8.8f, false, Ink, 12);
            var meta = new Style(Face.Body, 7.8f, false, Soft, 11);
            CardBox(54, 280, caption, indent, width, (c, x, y, w) =>
            {
                RoundedCard(c, x, y, w, 54);
                using var button = new SKPaint { IsAntialias = true, Color = Sage };
                c.DrawCircle(x + 28, y + 27, 14, button);
                PlayTriangle(c, x + 28, y + 27, 10, SKColors.White);
                var left = x + 52;
                DrawFitted(c, title, titleStyle, left, y + 22, w - 52 - 12);
                using var rail = new SKPaint { Color = new SKColor(0xd9, 0xcd, 0xbd), StrokeWidth = 1.4f, StrokeCap = SKStrokeCap.Round, IsAntialias = true };
                var timeWidth = durationMs is { } ? 34f : 0f;
                c.DrawLine(left, y + 37, x + w - 14 - timeWidth, y + 37, rail);
                using var knob = new SKPaint { IsAntialias = true, Color = Sage };
                c.DrawCircle(left, y + 37, 2.2f, knob);
                if (durationMs is { } ms)
                {
                    var f = Font(meta);
                    using var ink = new SKPaint { IsAntialias = true, Color = Soft };
                    var label = Clock(ms);
                    c.DrawText(label, x + w - 12 - f.MeasureText(label), y + 40, f, ink);
                }
            });
        }

        private void VideoCard(BookMedia? media, string title, string? caption, float indent, float width)
        {
            var poster = media?.PosterPath is { } p && ImageProcessor.CanDecode(p) ? ImageProcessor.Probe(p) : null;
            var w = Math.Min(290f, width);
            var h = poster is { } pr ? Math.Min(190f, w * pr.Height / pr.Width) : w * 9 / 16;
            if (poster is { } pp && h < w * pp.Height / pp.Width) w = h * pp.Width / pp.Height;
            var titleStyle = new Style(Face.Semi, 8.8f, false, SKColors.White, 12);
            var badge = new Style(Face.Body, 7.4f, false, SKColors.White, 10);
            var ms = media?.DurationMs;
            CardBox(h, w, caption, indent, width, (c, x, y, cw) =>
            {
                using (var clip = new SKPath())
                {
                    clip.AddRoundRect(new SKRoundRect(new SKRect(x, y, x + cw, y + h), 6));
                    c.Save();
                    c.ClipPath(clip, SKClipOperation.Intersect, true);
                    using var back = new SKPaint { Color = new SKColor(0x3d, 0x2c, 0x1e) };
                    c.DrawRect(x, y, cw, h, back);
                    if (poster is not null && media?.PosterPath is { } pp2)
                    {
                        using var bitmap = ImageProcessor.DecodeUpright(pp2, (int)Math.Min(1200, Math.Ceiling(cw * 3)));
                        if (bitmap is not null)
                        {
                            using var image = SKImage.FromBitmap(bitmap);
                            c.DrawImage(image, new SKRect(x, y, x + cw, y + h), new SKSamplingOptions(SKCubicResampler.Mitchell));
                        }
                    }
                    else
                    {
                        // No still was kept: the clip's name, over a dark frame.
                        var word = new Word();
                        word.Segs.AddRange(Segments(Fit(title, titleStyle, cw - 24), titleStyle));
                        DrawLine(c, [word], x + 12, y + h - 12);
                    }
                    c.Restore();
                }
                using var disc = new SKPaint { IsAntialias = true, Color = new SKColor(0x1c, 0x19, 0x17, 150) };
                c.DrawCircle(x + cw / 2, y + h / 2, 19, disc);
                PlayTriangle(c, x + cw / 2 + 1.5f, y + h / 2, 14, SKColors.White);
                if (ms is { } len)
                {
                    var f = Font(badge);
                    var label = Clock(len);
                    var bw = f.MeasureText(label) + 10;
                    using var pill = new SKPaint { IsAntialias = true, Color = new SKColor(0x1c, 0x19, 0x17, 190) };
                    c.DrawRoundRect(x + cw - bw - 6, y + h - 17, bw, 12, 4, 4, pill);
                    using var ink = new SKPaint { IsAntialias = true, Color = SKColors.White };
                    c.DrawText(label, x + cw - bw - 1, y + h - 8, f, ink);
                }
            });
        }

        private void InfoCard(Glyph glyph, string title, string subtitle, string? caption, float indent, float width)
        {
            var titleStyle = new Style(Face.Semi, 8.8f, false, Ink, 12);
            var sub = new Style(Face.Body, 7.6f, false, Soft, 11);
            CardBox(48, 280, caption, indent, width, (c, x, y, w) =>
            {
                RoundedCard(c, x, y, w, 48);
                using var tile = new SKPaint { IsAntialias = true, Color = new SKColor(0xe3, 0xed, 0xe6) };
                c.DrawRoundRect(x + 10, y + 9, 30, 30, 6, 6, tile);
                DrawGlyph(c, glyph, x + 25, y + 24);
                var left = x + 50;
                DrawFitted(c, title, titleStyle, left, y + 21, w - 50 - 12);
                if (subtitle.Length > 0) DrawFitted(c, subtitle, sub, left, y + 34, w - 50 - 12);
            });
        }

        private static void DrawGlyph(SKCanvas c, Glyph glyph, float cx, float cy)
        {
            using var fill = new SKPaint { IsAntialias = true, Color = Sage };
            using var line = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 1.2f, Color = Sage, StrokeCap = SKStrokeCap.Round, StrokeJoin = SKStrokeJoin.Round };
            switch (glyph)
            {
                case Glyph.Play:
                    c.DrawCircle(cx, cy, 8.5f, line);
                    PlayTriangle(c, cx + 0.8f, cy, 8, Sage);
                    break;
                case Glyph.Music:
                    c.DrawLine(cx + 3, cy - 7, cx + 3, cy + 4, line);
                    c.DrawLine(cx + 3, cy - 7, cx - 4, cy - 5, line);
                    c.DrawCircle(cx - 1.6f, cy + 5, 2.8f, fill);
                    c.DrawCircle(cx - 4, cy - 2, 0.1f, fill);
                    break;
                case Glyph.Pin:
                {
                    using var path = new SKPath();
                    path.MoveTo(cx, cy + 9);
                    path.CubicTo(cx - 9, cy - 1, cx - 7, cy - 9, cx, cy - 9);
                    path.CubicTo(cx + 7, cy - 9, cx + 9, cy - 1, cx, cy + 9);
                    c.DrawPath(path, line);
                    c.DrawCircle(cx, cy - 3, 2.6f, fill);
                    break;
                }
                case Glyph.Document:
                {
                    using var path = new SKPath();
                    path.MoveTo(cx - 6, cy - 8);
                    path.LineTo(cx + 2, cy - 8);
                    path.LineTo(cx + 6, cy - 4);
                    path.LineTo(cx + 6, cy + 8);
                    path.LineTo(cx - 6, cy + 8);
                    path.Close();
                    c.DrawPath(path, line);
                    c.DrawLine(cx + 2, cy - 8, cx + 2, cy - 4, line);
                    c.DrawLine(cx + 2, cy - 4, cx + 6, cy - 4, line);
                    c.DrawLine(cx - 3, cy + 1, cx + 3, cy + 1, line);
                    c.DrawLine(cx - 3, cy + 4, cx + 3, cy + 4, line);
                    break;
                }
                case Glyph.Picture:
                {
                    c.DrawRoundRect(cx - 8.5f, cy - 7, 17, 14, 2, 2, line);
                    c.DrawCircle(cx - 3.5f, cy - 2.5f, 1.6f, fill);
                    using var hill = new SKPath();
                    hill.MoveTo(cx - 8, cy + 6);
                    hill.LineTo(cx - 2, cy);
                    hill.LineTo(cx + 2, cy + 3);
                    hill.LineTo(cx + 5, cy - 1);
                    hill.LineTo(cx + 8, cy + 3);
                    c.DrawPath(hill, line);
                    break;
                }
                default: // a page: a globe
                    c.DrawCircle(cx, cy, 8.5f, line);
                    c.DrawLine(cx - 8.5f, cy, cx + 8.5f, cy, line);
                    c.DrawOval(cx, cy, 4, 8.5f, line);
                    break;
            }
        }

        // A picture, drawn at its own shape, with its caption under it.
        private void Picture(string path, ImageProbe probe, string? caption, float indent, float width)
        {
            var scale = Math.Min(width / probe.Width, 290f / probe.Height);
            scale = Math.Min(scale, 1.5f); // never blown up far past its own pixels (a point is 1/72")
            var w = probe.Width * scale;
            var h = probe.Height * scale;
            Need(h + 10);
            var x = ML + indent + (width - w) / 2;
            var y = _y + 2;
            var px = (int)Math.Min(1400, Math.Ceiling(w * 3));
            _ops.Add(c =>
            {
                using var bitmap = ImageProcessor.DecodeUpright(path, px);
                if (bitmap is null) return;
                using var image = SKImage.FromBitmap(bitmap);
                c.DrawImage(image, new SKRect(x, y, x + w, y + h), new SKSamplingOptions(SKCubicResampler.Mitchell));
            });
            _y += h + 6;
            Caption(caption, indent, width);
        }
    }
}
