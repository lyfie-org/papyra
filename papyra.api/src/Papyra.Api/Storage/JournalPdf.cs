using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Extensions.TaskLists;
using Markdig.Parsers;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using SkiaSharp;

namespace Papyra.Api.Storage;

/// <summary>One day of the book: its date, how it felt, and its text as Markdown.</summary>
public sealed record BookDay(DateOnly Date, int? Mood, string Body);

/// <summary>
/// The journal as a small book (A5): a cover, contents, then each month on a fresh page with its days
/// run on, set in Papyra's own faces (Sora, Marcellus, Roboto Mono — embedded, so the server needs no fonts).
/// Written with SkiaSharp's PDF backend, which the server already carries for pictures; the layout is ours:
/// Markdown becomes headings, paragraphs, lists (with ticked and unticked tasks), quotes, code and pictures,
/// wrapped to the page. Latin scripts print from the embedded faces; anything else uses a system face when the
/// host has one and prints "?" when it has none — the Markdown export is the lossless one.
/// </summary>
public static partial class JournalPdf
{
    // A5, in points.
    private const float W = 419.53f, H = 595.28f;
    private const float ML = 46, MR = 46, MT = 54, MB = 64;
    private const float TextW = W - ML - MR;

    private static readonly SKColor Ink = new(0x3d, 0x2c, 0x1e);
    private static readonly SKColor Soft = new(0x6b, 0x55, 0x48);
    private static readonly SKColor Faint = new(0x9a, 0x86, 0x78);
    private static readonly SKColor Sage = new(0x5f, 0x8f, 0x72);
    private static readonly SKColor Wash = new(0xf4, 0xef, 0xe7);

    private enum Face { Body, Semi, Heading, Mono }

    private readonly record struct Style(Face Face, float Size, bool Italic, SKColor Color, float Leading)
    {
        public Style Bold() => Face == Face.Body ? this with { Face = Face.Semi } : this;
        public Style Slant() => this with { Italic = true };
    }

    private static readonly Style Body = new(Face.Body, 9.4f, false, Ink, 14.6f);

    [GeneratedRegex(@"\[\[(?<t>[^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|(?<a>[^\]\r\n]*))?\]\]")]
    private static partial Regex WikiRx();

    private static readonly HashSet<string> PictureTypes = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif" };

    private static readonly MarkdownPipeline Pipeline = BuildPipeline();

    private static MarkdownPipeline BuildPipeline()
    {
        var builder = new MarkdownPipelineBuilder().UsePipeTables().UseTaskLists().UseEmphasisExtras().DisableHtml();
        // A line indented four spaces (or a tab) is a paragraph here, as in the editor — which is where a
        // Tab or a pasted indent comes from — never a code block; code is fenced.
        builder.BlockParsers.RemoveAll(p => p is IndentedCodeBlockParser);
        return builder.Build();
    }

    private static readonly string[] MoodNames = ["", "Rough", "Low", "Okay", "Good", "Great"];

    // ── Fonts ────────────────────────────────────────────────────────────────

    private static readonly Lazy<Dictionary<Face, SKTypeface>> Faces = new(() => new()
    {
        [Face.Body] = LoadFace("Sora-Regular.ttf"),
        [Face.Semi] = LoadFace("Sora-SemiBold.ttf"),
        [Face.Heading] = LoadFace("Marcellus-Regular.ttf"),
        [Face.Mono] = LoadFace("RobotoMono-Regular.ttf"),
    });

    private static SKTypeface LoadFace(string file)
    {
        using var stream = typeof(JournalPdf).Assembly.GetManifestResourceStream("Papyra.Fonts." + file);
        return (stream is null ? null : SKTypeface.FromStream(stream)) ?? SKTypeface.Default;
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /// <param name="locateMedia">An embedded file name to what is known of it, or null when it isn't there.</param>
    public static void Write(Stream output, IReadOnlyList<BookDay> days, string title, string? author, Func<string, BookMedia?> locateMedia)
    {
        var book = new Book(locateMedia);
        try
        {
            var ordered = days.OrderBy(d => d.Date).ToList();
            book.Lay(ordered);
            book.Render(output, ordered, title, author);
        }
        finally { book.Dispose(); }
    }

    private sealed class Seg(string text, SKFont font, SKColor color, float width)
    {
        public string Text { get; } = text;
        public SKFont Font { get; } = font;
        public SKColor Color { get; } = color;
        public float Width { get; } = width;
    }

    private sealed class Word
    {
        public List<Seg> Segs { get; } = [];
        public float Width => Segs.Sum(s => s.Width);
        public float Space { get; set; }
        public bool Break { get; init; }
    }

    private abstract record Run;
    private sealed record TextRun(string Text, Style Style) : Run;
    private sealed record BreakRun : Run;
    private sealed record EmbedRun(EmbedSpec Spec) : Run;

    private sealed partial class Book(Func<string, BookMedia?> locateMedia) : IDisposable
    {
        private readonly Func<string, BookMedia?> _media = locateMedia;
        private readonly List<List<Action<SKCanvas>>> _pages = [];
        private List<Action<SKCanvas>> _ops = [];
        private float _y;
        private readonly Dictionary<(Face, float, bool), SKFont> _fonts = [];
        private readonly Dictionary<int, SKTypeface?> _fallback = [];
        private readonly List<(string Label, int Page, bool Year)> _contents = [];
        private readonly List<IDisposable> _owned = [];

        public void Dispose()
        {
            foreach (var f in _fonts.Values) f.Dispose();
            foreach (var o in _owned) o.Dispose();
            foreach (var t in _fallback.Values) t?.Dispose();
        }

        // ── Fonts and words ──────────────────────────────────────────────────

        private SKFont Font(Style s)
        {
            if (!_fonts.TryGetValue((s.Face, s.Size, s.Italic), out var font))
            {
                font = new SKFont(Faces.Value[s.Face], s.Size) { Subpixel = true, LinearMetrics = true, Hinting = SKFontHinting.None, Edging = SKFontEdging.SubpixelAntialias };
                if (s.Italic) font.SkewX = -0.2f;
                _fonts[(s.Face, s.Size, s.Italic)] = font;
            }
            return font;
        }

        private SKFont FontFor(Style s, SKTypeface face)
        {
            var key = (s.Face, s.Size, s.Italic);
            var font = new SKFont(face, s.Size) { Subpixel = true, LinearMetrics = true, Hinting = SKFontHinting.None, Edging = SKFontEdging.SubpixelAntialias };
            if (s.Italic) font.SkewX = -0.2f;
            _owned.Add(font);
            _ = key;
            return font;
        }

        // A face for a character the page's own face doesn't have (a system face if the host has one), or null.
        private SKTypeface? Fallback(int codePoint)
        {
            if (_fallback.TryGetValue(codePoint, out var cached)) return cached;
            SKTypeface? found = null;
            try { found = SKFontManager.Default.MatchCharacter(codePoint); } catch (Exception) { /* none */ }
            _fallback[codePoint] = found;
            return found;
        }

        // A run of text as word pieces drawn in the run's face, with fallbacks where it lacks a glyph.
        private List<Seg> Segments(string text, Style style)
        {
            var primary = Faces.Value[style.Face];
            var segs = new List<Seg>();
            var sb = new StringBuilder();
            SKFont? current = null;
            void Flush()
            {
                if (sb.Length == 0 || current is null) return;
                var t = sb.ToString();
                segs.Add(new Seg(t, current, style.Color, current.MeasureText(t)));
                sb.Clear();
            }
            foreach (var rune in text.EnumerateRunes())
            {
                SKFont use;
                var ch = rune.ToString();
                if (primary.ContainsGlyph(rune.Value)) use = Font(style);
                else if (Fallback(rune.Value) is { } fb) use = FontFor(style, fb);
                else { use = Font(style); ch = "?"; }
                if (!ReferenceEquals(use, current)) { Flush(); current = use; }
                sb.Append(ch);
            }
            Flush();
            return segs;
        }

        private List<Word> Words(IEnumerable<Run> runs)
        {
            var words = new List<Word>();
            Word? cur = null;
            foreach (var run in runs)
            {
                if (run is BreakRun) { if (cur is not null) { words.Add(cur); cur = null; } words.Add(new Word { Break = true }); continue; }
                if (run is not TextRun t) continue;
                var space = Font(t.Style).Size * 0.3f;
                var i = 0;
                while (i < t.Text.Length)
                {
                    if (char.IsWhiteSpace(t.Text[i]))
                    {
                        if (cur is not null) { words.Add(cur); cur = null; }
                        while (i < t.Text.Length && char.IsWhiteSpace(t.Text[i])) i++;
                        continue;
                    }
                    var start = i;
                    while (i < t.Text.Length && !char.IsWhiteSpace(t.Text[i])) i++;
                    cur ??= new Word { Space = space };
                    cur.Segs.AddRange(Segments(t.Text[start..i], t.Style));
                }
            }
            if (cur is not null) words.Add(cur);
            return words;
        }

        // ── Pages ────────────────────────────────────────────────────────────

        private void NewPage()
        {
            _ops = [];
            _pages.Add(_ops);
            _y = MT;
        }

        private void Need(float h)
        {
            if (_pages.Count == 0 || _y + h > H - MB) NewPage();
        }

        // Wrap words into lines and set them, flowing onto new pages as they fill.
        private void SetWords(List<Word> words, float indent, float width, Style style, bool center = false)
        {
            var line = new List<Word>();
            float used = 0;
            void Emit()
            {
                if (line.Count == 0 && words.Count == 0) return;
                Need(style.Leading);
                var by = _y + style.Leading * 0.72f;
                var snapshot = line.ToArray();
                var x0 = ML + indent;
                if (center)
                {
                    var lineWidth = snapshot.Sum(w => w.Width) + snapshot.Skip(1).Sum(w => w.Space);
                    x0 += Math.Max(0, (width - lineWidth) / 2);
                }
                _ops.Add(c => DrawLine(c, snapshot, x0, by));
                _y += style.Leading;
                line.Clear();
                used = 0;
            }
            foreach (var word in words)
            {
                if (word.Break) { Emit(); continue; }
                foreach (var piece in Chop(word, width))
                {
                    var need = line.Count > 0 ? piece.Space + piece.Width : piece.Width;
                    if (line.Count > 0 && used + need > width) Emit();
                    used += line.Count > 0 ? piece.Space + piece.Width : piece.Width;
                    line.Add(piece);
                }
            }
            if (line.Count > 0) Emit();
        }

        // A word wider than the line (a long address) is cut where it must be.
        private static IEnumerable<Word> Chop(Word word, float width)
        {
            if (word.Width <= width) { yield return word; yield break; }
            var piece = new Word { Space = word.Space };
            float w = 0;
            foreach (var seg in word.Segs)
            {
                var text = seg.Text;
                var start = 0;
                while (start < text.Length)
                {
                    var take = 1;
                    while (start + take < text.Length && w + seg.Font.MeasureText(text.AsSpan(start, take + 1)) <= width) take++;
                    var part = text.Substring(start, take);
                    var pw = seg.Font.MeasureText(part);
                    if (w + pw > width && piece.Segs.Count > 0) { yield return piece; piece = new Word { Space = word.Space }; w = 0; }
                    piece.Segs.Add(new Seg(part, seg.Font, seg.Color, pw));
                    w += pw;
                    start += take;
                }
            }
            if (piece.Segs.Count > 0) yield return piece;
        }

        private static void DrawLine(SKCanvas canvas, Word[] words, float x, float baseline)
        {
            using var paint = new SKPaint { IsAntialias = true };
            for (var i = 0; i < words.Length; i++)
            {
                if (i > 0) x += words[i].Space;
                foreach (var seg in words[i].Segs)
                {
                    paint.Color = seg.Color;
                    canvas.DrawText(seg.Text, x, baseline, seg.Font, paint);
                    x += seg.Width;
                }
            }
        }

        // ── Laying out the days ──────────────────────────────────────────────

        public void Lay(IReadOnlyList<BookDay> days)
        {
            string? month = null;
            foreach (var day in days)
            {
                var key = day.Date.ToString("yyyy-MM", CultureInfo.InvariantCulture);
                if (key != month)
                {
                    month = key;
                    NewPage();
                    _contents.Add((day.Date.ToString("MMMM yyyy", CultureInfo.InvariantCulture), _pages.Count, false));
                    MonthHeading(day.Date);
                }
                else
                {
                    // A day starts with room for its heading and a few lines.
                    Need(110);
                    _y += 22;
                }
                DayHeading(day);
                RenderBody(day.Body);
            }
            if (_pages.Count == 0) NewPage();
        }

        private void MonthHeading(DateOnly date)
        {
            var year = date.Year.ToString(CultureInfo.InvariantCulture);
            var name = date.ToString("MMMM", CultureInfo.InvariantCulture);
            var yearStyle = new Style(Face.Body, 8, false, Faint, 10);
            var nameStyle = new Style(Face.Heading, 28, false, Ink, 34);
            var top = _y;
            _ops.Add(c => DrawSpaced(c, year, ML, top + 8, Font(yearStyle), Faint, 2.6f));
            var by = top + 12 + 28;
            _ops.Add(c =>
            {
                using var paint = new SKPaint { IsAntialias = true, Color = Ink };
                c.DrawText(name, ML, by, Font(nameStyle), paint);
                using var rule = new SKPaint { Color = Sage, StrokeWidth = 0.8f, IsAntialias = true };
                c.DrawLine(ML, by + 12, ML + 34, by + 12, rule);
            });
            _y = by + 12 + 26;
        }

        private void DayHeading(BookDay day)
        {
            var weekday = day.Date.ToString("dddd", CultureInfo.InvariantCulture).ToUpperInvariant();
            var date = day.Date.ToString("MMMM d", CultureInfo.InvariantCulture);
            var mood = day.Mood is >= 1 and <= 5 ? MoodNames[day.Mood.Value] : null;
            var small = new Style(Face.Body, 7, false, Faint, 10);
            var big = new Style(Face.Heading, 15.5f, false, Ink, 20);
            Need(54);
            var top = _y;
            _ops.Add(c =>
            {
                DrawSpaced(c, weekday, ML, top + 7, Font(small), Faint, 1.8f);
                using var paint = new SKPaint { IsAntialias = true, Color = Ink };
                c.DrawText(date, ML, top + 25, Font(big), paint);
                if (mood is not null)
                {
                    var f = Font(new Style(Face.Body, 7.6f, false, Soft, 10));
                    using var soft = new SKPaint { IsAntialias = true, Color = Soft };
                    var w = f.MeasureText(mood);
                    c.DrawText(mood, ML + TextW - w, top + 24, f, soft);
                }
                using var rule = new SKPaint { Color = new SKColor(0xe2, 0xd8, 0xca), StrokeWidth = 0.5f };
                c.DrawLine(ML, top + 33, ML + TextW, top + 33, rule);
            });
            _y = top + 33 + 11;
        }

        // ── Markdown to the page ─────────────────────────────────────────────

        private void RenderBody(string body)
        {
            var doc = Markdown.Parse(Prepare(body), Pipeline);
            Blocks(doc, 0, TextW, Body);
        }

        private void Blocks(IEnumerable<Block> blocks, float indent, float width, Style style)
        {
            foreach (var block in blocks)
            {
                switch (block)
                {
                    case HeadingBlock h:
                    {
                        var hs = h.Level switch
                        {
                            1 => new Style(Face.Heading, 14, false, Ink, 19),
                            2 => new Style(Face.Heading, 12, false, Ink, 17),
                            _ => new Style(Face.Semi, 9.8f, false, Ink, 15),
                        };
                        _y += 6;
                        Need(hs.Leading * 2);
                        Inlines(h.Inline, indent, width, hs);
                        _y += 3;
                        break;
                    }
                    case ParagraphBlock p:
                        Inlines(p.Inline, indent, width, style);
                        _y += 6;
                        break;
                    case ListBlock list:
                        List(list, indent, width, style);
                        _y += 2;
                        break;
                    case QuoteBlock q:
                    {
                        Need(style.Leading);
                        var startPage = _pages.Count;
                        var y0 = _y;
                        Blocks(q, indent + 12, width - 12, style.Slant() with { Color = Soft });
                        var y1 = _y;
                        var ops = _pages[startPage - 1];
                        var bottom = startPage == _pages.Count ? y1 - 6 : H - MB;
                        var x = ML + indent;
                        ops.Add(c =>
                        {
                            using var bar = new SKPaint { Color = Sage, StrokeWidth = 1.6f };
                            c.DrawLine(x + 1, y0 + 1, x + 1, bottom, bar);
                        });
                        break;
                    }
                    case FencedCodeBlock or CodeBlock:
                        Code((LeafBlock)block, indent, width);
                        _y += 6;
                        break;
                    case ThematicBreakBlock:
                    {
                        Need(20);
                        var y = _y + 10;
                        var x = ML + indent;
                        _ops.Add(c =>
                        {
                            using var rule = new SKPaint { Color = Faint, StrokeWidth = 0.6f };
                            c.DrawLine(x + (width - 40) / 2, y, x + (width + 40) / 2, y, rule);
                        });
                        _y += 22;
                        break;
                    }
                    case Table table:
                        foreach (var row in table.OfType<TableRow>())
                        {
                            var rowStyle = row.IsHeader ? style.Bold() : style;
                            var runs = new List<Run>();
                            var first = true;
                            foreach (var cell in row.OfType<TableCell>())
                            {
                                if (!first) runs.Add(new TextRun("  ·  ", rowStyle with { Color = Faint }));
                                first = false;
                                foreach (var para in cell.OfType<ParagraphBlock>()) Collect(para.Inline, rowStyle, runs);
                            }
                            SetWords(Words(runs), indent, width, rowStyle);
                        }
                        _y += 6;
                        break;
                    case ContainerBlock container when block is not (HeadingBlock or ParagraphBlock):
                        Blocks(container, indent, width, style);
                        break;
                    // HTML and link definitions carry nothing to print.
                }
            }
        }

        private void List(ListBlock list, float indent, float width, Style style)
        {
            var n = int.TryParse(list.OrderedStart, out var start) ? start : 1;
            foreach (var item in list.OfType<ListItemBlock>())
            {
                var task = item.Descendants<TaskList>().FirstOrDefault();
                Need(style.Leading + 2);
                var top = _y;
                var x = ML + indent;
                var by = top + style.Leading * 0.72f;
                var pageOps = _ops;
                if (task is not null)
                {
                    var done = task.Checked;
                    pageOps.Add(c =>
                    {
                        using var stroke = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 0.8f, Color = done ? Sage : Faint };
                        c.DrawRoundRect(x + 1, by - 7.4f, 7.4f, 7.4f, 1.4f, 1.4f, stroke);
                        if (!done) return;
                        using var tick = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 1.1f, Color = Sage, StrokeCap = SKStrokeCap.Round };
                        c.DrawLine(x + 2.6f, by - 3.6f, x + 4.1f, by - 2.1f, tick);
                        c.DrawLine(x + 4.1f, by - 2.1f, x + 7, by - 6.2f, tick);
                    });
                }
                else if (list.IsOrdered)
                {
                    var label = n.ToString(CultureInfo.InvariantCulture) + ".";
                    pageOps.Add(c =>
                    {
                        using var paint = new SKPaint { IsAntialias = true, Color = Soft };
                        c.DrawText(label, x, by, Font(style with { Color = Soft }), paint);
                    });
                }
                else
                {
                    pageOps.Add(c =>
                    {
                        using var paint = new SKPaint { IsAntialias = true, Color = Sage };
                        c.DrawCircle(x + 2.4f, by - 3.1f, 1.5f, paint);
                    });
                }
                n++;
                var done2 = task?.Checked == true;
                Blocks(item, indent + 16, width - 16, done2 ? style with { Color = Soft } : style);
                // A paragraph closes with a gap; keep list rows close.
                _y = Math.Max(top + style.Leading, _y - 6 + 2);
            }
        }

        private void Code(LeafBlock block, float indent, float width)
        {
            var mono = new Style(Face.Mono, 7.8f, false, Ink, 11.6f);
            var font = Font(mono);
            var charW = Math.Max(1, font.MeasureText("0"));
            var perLine = Math.Max(8, (int)((width - 12) / charW));
            _y += 2;
            foreach (var raw in block.Lines.ToString().Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.Replace("\t", "    ");
                var rows = line.Length == 0 ? [""] : Enumerable.Range(0, (line.Length + perLine - 1) / perLine).Select(i => line.Substring(i * perLine, Math.Min(perLine, line.Length - i * perLine))).ToArray();
                foreach (var row in rows)
                {
                    Need(mono.Leading);
                    var top = _y;
                    var x = ML + indent;
                    var text = row;
                    _ops.Add(c =>
                    {
                        using var bg = new SKPaint { Color = Wash };
                        c.DrawRect(x, top, width, mono.Leading, bg);
                        using var paint = new SKPaint { IsAntialias = true, Color = Ink };
                        c.DrawText(text, x + 6, top + mono.Leading * 0.74f, font, paint);
                    });
                    _y += mono.Leading;
                }
            }
        }

        private void Inlines(ContainerInline? inline, float indent, float width, Style style)
        {
            if (inline is null) return;
            var runs = new List<Run>();
            Collect(inline, style, runs);
            var pending = new List<Run>();
            foreach (var run in runs)
            {
                if (run is EmbedRun embed)
                {
                    SetWords(Words(pending), indent, width, style);
                    pending.Clear();
                    Embed(embed.Spec, indent, width);
                }
                else pending.Add(run);
            }
            SetWords(Words(pending), indent, width, style);
        }

        private void Collect(ContainerInline container, Style style, List<Run> runs)
        {
            foreach (var node in container)
            {
                switch (node)
                {
                    case LiteralInline lit:
                        runs.Add(new TextRun(lit.Content.ToString(), style));
                        break;
                    case CodeInline code:
                        runs.Add(new TextRun(code.Content, style with { Face = Face.Mono, Size = style.Size * 0.9f, Color = Soft }));
                        break;
                    case EmphasisInline em:
                    {
                        var s = em.DelimiterChar is '*' or '_'
                            ? (em.DelimiterCount >= 2 ? style.Bold() : style) with { Italic = style.Italic || em.DelimiterCount is 1 or 3 }
                            : style;
                        if (em.DelimiterCount == 3) s = style.Bold() with { Italic = true };
                        Collect(em, s, runs);
                        break;
                    }
                    case LinkInline link when link.IsImage:
                        if (link.Url is { } url && Decode(url) is { } spec)
                            runs.Add(new EmbedRun(spec));
                        else runs.Add(new TextRun(link.FirstChild is LiteralInline alt ? alt.Content.ToString() : "[image]", style.Slant()));
                        break;
                    case LinkInline link:
                        Collect(link, style with { Color = Sage }, runs);
                        break;
                    case AutolinkInline auto:
                        runs.Add(new TextRun(auto.Url, style with { Color = Sage }));
                        break;
                    case LineBreakInline br:
                        if (br.IsHard) runs.Add(new BreakRun());
                        else runs.Add(new TextRun(" ", style));
                        break;
                    case HtmlEntityInline entity:
                        runs.Add(new TextRun(entity.Transcoded.ToString(), style));
                        break;
                    case TaskList:
                    case HtmlInline:
                        break;
                    case ContainerInline nested:
                        Collect(nested, style, runs);
                        break;
                }
            }
        }

        // ── Cover, contents, numbering ───────────────────────────────────────

        private static void DrawSpaced(SKCanvas c, string text, float x, float baseline, SKFont font, SKColor color, float spacing)
        {
            using var paint = new SKPaint { IsAntialias = true, Color = color };
            foreach (var rune in text.EnumerateRunes())
            {
                var s = rune.ToString();
                c.DrawText(s, x, baseline, font, paint);
                x += font.MeasureText(s) + spacing;
            }
        }

        private static float SpacedWidth(string text, SKFont font, float spacing) =>
            text.EnumerateRunes().Sum(r => font.MeasureText(r.ToString()) + spacing) - spacing;

        public void Render(Stream output, IReadOnlyList<BookDay> days, string title, string? author)
        {
            // Contents: a row per month, a year heading above each new year.
            var rows = new List<(string Label, int Page, bool Year)>();
            var lastYear = "";
            foreach (var (label, page, _) in _contents)
            {
                var year = label[^4..];
                if (year != lastYear) { rows.Add((year, page, true)); lastYear = year; }
                rows.Add((label[..^5], page, false));
            }
            const float rowH = 21, headH = 70;
            var perPage = (int)((H - MB - MT - headH) / rowH);
            var tocPages = Math.Max(1, (int)Math.Ceiling(rows.Count / (double)perPage));

            var meta = new SKDocumentPdfMetadata
            {
                Title = title, Author = author ?? "", Creator = "Papyra", Producer = "Papyra (Skia)",
                Creation = DateTime.UtcNow, Modified = DateTime.UtcNow, EncodingQuality = 80, RasterDpi = 150,
            };
            using var doc = SKDocument.CreatePdf(output, meta);

            // Cover.
            using (var c = doc.BeginPage(W, H))
            {
                c.Clear(SKColors.White);
                var titleFont = Font(new Style(Face.Heading, 38, false, Ink, 44));
                var subFont = Font(new Style(Face.Body, 9, false, Soft, 14));
                var first = days[0].Date;
                var last = days[^1].Date;
                var span = first.Year == last.Year && first.Month == last.Month
                    ? first.ToString("MMMM yyyy", CultureInfo.InvariantCulture)
                    : $"{first.ToString("MMMM yyyy", CultureInfo.InvariantCulture)} – {last.ToString("MMMM yyyy", CultureInfo.InvariantCulture)}";
                var words = days.Sum(d => JournalService.CountWords(d.Body));
                var counts = $"{days.Count:N0} {(days.Count == 1 ? "day" : "days")} · {words:N0} {(words == 1 ? "word" : "words")}";
                using var ink = new SKPaint { IsAntialias = true, Color = Ink };
                using var soft = new SKPaint { IsAntialias = true, Color = Soft };
                using var rule = new SKPaint { Color = Sage, StrokeWidth = 1f, IsAntialias = true };
                var ty = H * 0.38f;
                c.DrawText(title, W / 2 - titleFont.MeasureText(title) / 2, ty, titleFont, ink);
                c.DrawLine(W / 2 - 20, ty + 26, W / 2 + 20, ty + 26, rule);
                c.DrawText(span, W / 2 - subFont.MeasureText(span) / 2, ty + 56, subFont, soft);
                c.DrawText(counts, W / 2 - subFont.MeasureText(counts) / 2, ty + 74, subFont, soft);
                if (!string.IsNullOrWhiteSpace(author))
                {
                    var af = Font(new Style(Face.Heading, 12, false, Ink, 16));
                    c.DrawText(author, W / 2 - af.MeasureText(author) / 2, H - 120, af, ink);
                }
                var foot = "Made with Papyra";
                var ff = Font(new Style(Face.Body, 7, false, Faint, 10));
                DrawSpaced(c, foot.ToUpperInvariant(), W / 2 - SpacedWidth(foot.ToUpperInvariant(), ff, 1.6f) / 2, H - 64, ff, Faint, 1.6f);
                doc.EndPage();
            }

            // Contents.
            for (var p = 0; p < tocPages; p++)
            {
                using var c = doc.BeginPage(W, H);
                c.Clear(SKColors.White);
                var y = MT;
                if (p == 0)
                {
                    var hf = Font(new Style(Face.Heading, 22, false, Ink, 28));
                    using var ink = new SKPaint { IsAntialias = true, Color = Ink };
                    c.DrawText("Contents", ML, y + 22, hf, ink);
                    using var rule = new SKPaint { Color = Sage, StrokeWidth = 0.8f, IsAntialias = true };
                    c.DrawLine(ML, y + 34, ML + 34, y + 34, rule);
                }
                y += headH - 10;
                foreach (var (label, page, year) in rows.Skip(p * perPage).Take(perPage))
                {
                    var f = year ? Font(new Style(Face.Heading, 12, false, Ink, 16)) : Font(new Style(Face.Body, 9, false, Ink, 14));
                    using var ink = new SKPaint { IsAntialias = true, Color = year ? Ink : Soft };
                    var num = page.ToString(CultureInfo.InvariantCulture);
                    if (year) y += 6;
                    c.DrawText(label, ML, y + 12, f, ink);
                    if (!year)
                    {
                        var nf = Font(new Style(Face.Body, 9, false, Soft, 14));
                        var nw = nf.MeasureText(num);
                        c.DrawText(num, ML + TextW - nw, y + 12, nf, ink);
                        var lx = ML + f.MeasureText(label) + 8;
                        using var dots = new SKPaint
                        {
                            Color = new SKColor(0xc9, 0xbc, 0xad), StrokeWidth = 0.7f, IsAntialias = true,
                            PathEffect = SKPathEffect.CreateDash([0.6f, 3.2f], 0), StrokeCap = SKStrokeCap.Round,
                        };
                        c.DrawLine(lx, y + 10, ML + TextW - nw - 8, y + 10, dots);
                    }
                    y += rowH;
                }
                doc.EndPage();
            }

            // The days.
            var numFont = Font(new Style(Face.Body, 7.6f, false, Faint, 10));
            for (var i = 0; i < _pages.Count; i++)
            {
                using var c = doc.BeginPage(W, H);
                c.Clear(SKColors.White);
                foreach (var op in _pages[i]) op(c);
                var num = (i + 1).ToString(CultureInfo.InvariantCulture);
                using var paint = new SKPaint { IsAntialias = true, Color = Faint };
                c.DrawText(num, W / 2 - numFont.MeasureText(num) / 2, H - 34, numFont, paint);
                doc.EndPage();
            }
            doc.Close();
        }
    }
}
