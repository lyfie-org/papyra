using System.Text;
using System.Text.Unicode;

namespace Papyra.Api.Storage;

/// <summary>What an upload actually is, decided from its bytes.</summary>
/// <param name="Kind">image · gif · video · audio · document · file — drives the size limit.</param>
/// <param name="Extension">The extension the server stores it under (lower-case, with the dot).</param>
public readonly record struct SniffedMedia(string Kind, string Extension);

/// <summary>
/// Identifies an attachment by its magic bytes rather than by the name the upload
/// claims. The server — never the client — picks the stored extension, and the
/// extension is what <see cref="MediaResponder"/> later serves the file as, so a
/// page renamed <c>photo.png</c> can never come back as <c>text/html</c>.
///
/// The client's extension is consulted only to choose between siblings that share
/// a container (a .docx and an .xlsx are both zips; .mp4 and .m4v are both
/// ISO-BMFF), and only when it is already one the container allows. Anything
/// unrecognised is stored as opaque <c>.bin</c>, served as a download.
/// </summary>
public static class MediaSniffer
{
    /// <summary>How many leading bytes <see cref="Sniff"/> wants to see.</summary>
    public const int HeaderBytes = 8192;

    private static readonly HashSet<string> ZipFamily = new(StringComparer.OrdinalIgnoreCase)
        { ".zip", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub" };
    private static readonly HashSet<string> OleFamily = new(StringComparer.OrdinalIgnoreCase)
        { ".doc", ".xls", ".ppt", ".msg" };
    private static readonly HashSet<string> TextFamily = new(StringComparer.OrdinalIgnoreCase)
        { ".txt", ".md", ".csv", ".tsv", ".json", ".log" };
    private static readonly HashSet<string> Mp4Video = new(StringComparer.OrdinalIgnoreCase) { ".mp4", ".m4v" };

    /// <param name="head">The first bytes of the file (up to <see cref="HeaderBytes"/>).</param>
    /// <param name="clientName">The name the upload arrived with — a tie-breaker only.</param>
    public static SniffedMedia Sniff(ReadOnlySpan<byte> head, string? clientName)
    {
        var hint = Path.GetExtension(clientName ?? string.Empty).ToLowerInvariant();

        // ── Raster images ──
        if (StartsWith(head, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return new("image", ".png");
        if (StartsWith(head, [0xFF, 0xD8, 0xFF])) return new("image", ".jpg");
        if (Ascii(head, 0, "GIF87a") || Ascii(head, 0, "GIF89a")) return new("gif", ".gif");
        if (Ascii(head, 0, "RIFF") && Ascii(head, 8, "WEBP")) return new("image", ".webp");
        if (Ascii(head, 0, "BM") && head.Length >= 26 && head[14] is 12 or 40 or 52 or 56 or 64 or 108 or 124)
            return new("image", ".bmp");
        if (StartsWith(head, [0x00, 0x00, 0x01, 0x00]) && head.Length >= 6 && head[4] + head[5] > 0)
            return new("image", ".ico");
        if (StartsWith(head, [0x49, 0x49, 0x2A, 0x00]) || StartsWith(head, [0x4D, 0x4D, 0x00, 0x2A]))
            return new("image", ".tif");

        // ── ISO base media (MP4 / MOV / M4A / HEIC / AVIF) ──
        if (Ascii(head, 4, "ftyp") && head.Length >= 12)
        {
            var brand = Encoding.ASCII.GetString(head.Slice(8, 4));
            var compatible = CompatibleBrands(head);
            switch (brand)
            {
                case "avif" or "avis": return new("image", ".avif");
                case "heic" or "heix" or "hevc" or "hevx" or "heim" or "heis" or "msf1":
                    return new("image", hint == ".heif" ? ".heif" : ".heic");
                case "mif1":
                    return compatible.Contains("avif") ? new("image", ".avif") : new("image", hint == ".heif" ? ".heif" : ".heic");
                case "qt  ": return new("video", ".mov");
                case "M4A " or "M4B " or "M4P ": return new("audio", ".m4a");
                case "M4V " or "M4VH" or "M4VP": return new("video", ".m4v");
                case "crx ": return new("file", ".bin");
            }
            if (hint == ".m4a") return new("audio", ".m4a");
            return new("video", Mp4Video.Contains(hint) ? hint : ".mp4");
        }
        // Pre-ftyp QuickTime files open straight on an atom.
        if (head.Length >= 8 && (Ascii(head, 4, "moov") || Ascii(head, 4, "mdat") || Ascii(head, 4, "wide")
            || Ascii(head, 4, "free") || Ascii(head, 4, "skip") || Ascii(head, 4, "pnot")))
            return new("video", ".mov");

        // ── Other video / audio ──
        if (StartsWith(head, [0x1A, 0x45, 0xDF, 0xA3]))
            return IndexOf(head[..Math.Min(head.Length, 64)], "webm"u8) >= 0
                ? new(hint == ".weba" ? "audio" : "video", hint == ".weba" ? ".weba" : ".webm")
                : new("video", ".mkv");
        if (Ascii(head, 0, "OggS"))
        {
            if (IndexOf(head, "OpusHead"u8) >= 0) return new("audio", ".opus");
            if (IndexOf(head, "theora"u8) >= 0) return new("video", ".ogv");
            return new("audio", hint == ".oga" ? ".oga" : ".ogg");
        }
        if (Ascii(head, 0, "RIFF") && Ascii(head, 8, "WAVE")) return new("audio", ".wav");
        if (Ascii(head, 0, "RIFF") && Ascii(head, 8, "AVI ")) return new("video", ".avi");
        if (Ascii(head, 0, "fLaC")) return new("audio", ".flac");
        if (Ascii(head, 0, "ID3")) return new("audio", ".mp3");
        if (head.Length >= 2 && head[0] == 0xFF)
        {
            // ADTS AAC: sync word + layer bits 00.
            if ((head[1] & 0xF6) == 0xF0) return new("audio", ".aac");
            // MPEG audio frame sync (layer I–III) — only when the name agrees,
            // since two bytes alone are too weak a signature.
            if ((head[1] & 0xE0) == 0xE0 && hint == ".mp3") return new("audio", ".mp3");
        }

        // ── Documents and archives ──
        if (IndexOf(head[..Math.Min(head.Length, 1024)], "%PDF-"u8) >= 0) return new("document", ".pdf");
        if (StartsWith(head, [0x50, 0x4B, 0x03, 0x04]) || StartsWith(head, [0x50, 0x4B, 0x05, 0x06]))
            return new("document", ZipFamily.Contains(hint) ? hint : ".zip");
        if (StartsWith(head, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))
            return OleFamily.Contains(hint) ? new("document", hint) : new("file", ".bin");
        if (Ascii(head, 0, @"{\rtf")) return new("document", ".rtf");
        if (StartsWith(head, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return new("file", ".7z");
        if (Ascii(head, 0, "Rar!\u001A\u0007")) return new("file", ".rar");
        if (StartsWith(head, [0x1F, 0x8B])) return new("file", hint == ".tgz" ? ".tgz" : ".gz");

        // ── Text: SVG first (it is XML text), then plain text ──
        if (IsText(head))
        {
            if (LooksLikeSvg(head)) return new("image", ".svg");
            // Markup of any other flavour is stored — and later served — as inert
            // plain text: an uploaded page can be read, never run.
            return new("document", TextFamily.Contains(hint) ? hint : ".txt");
        }

        return new("file", ".bin");
    }

    /// <summary>
    /// UTF-8 (optionally with BOM) and no NULs. A multi-byte character cut off by
    /// the end of the sampled window still counts as text.
    /// </summary>
    public static bool IsText(ReadOnlySpan<byte> head)
    {
        if (head.Length == 0) return false;
        if (head.IndexOf((byte)0) >= 0) return false;
        var span = head;
        // Trim a trailing partial sequence (at most 3 bytes) before validating.
        for (var back = 1; back <= Math.Min(3, span.Length); back++)
        {
            var b = span[^back];
            if ((b & 0xC0) == 0x80) continue;           // continuation byte: keep looking back
            if ((b & 0x80) == 0) break;                   // ASCII: nothing cut
            var need = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
            if (need > back) span = span[..^back];
            break;
        }
        return Utf8.IsValid(span);
    }

    private static bool LooksLikeSvg(ReadOnlySpan<byte> head)
    {
        var text = Encoding.UTF8.GetString(head[..Math.Min(head.Length, 4096)]).TrimStart('﻿');
        var i = 0;
        while (i < text.Length)
        {
            while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
            if (i >= text.Length || text[i] != '<') return false;
            if (string.CompareOrdinal(text, i, "<?", 0, 2) == 0) { i = Skip(text, i, "?>"); continue; }
            if (string.CompareOrdinal(text, i, "<!--", 0, 4) == 0) { i = Skip(text, i, "-->"); continue; }
            if (string.CompareOrdinal(text, i, "<!", 0, 2) == 0) { i = Skip(text, i, ">"); continue; }
            return text.Length >= i + 4
                && string.Compare(text, i + 1, "svg", 0, 3, StringComparison.OrdinalIgnoreCase) == 0
                && (text.Length == i + 4 || !char.IsLetterOrDigit(text[i + 4]));
        }
        return false;
    }

    private static int Skip(string text, int from, string terminator)
    {
        var at = text.IndexOf(terminator, from, StringComparison.Ordinal);
        return at < 0 ? text.Length : at + terminator.Length;
    }

    private static HashSet<string> CompatibleBrands(ReadOnlySpan<byte> head)
    {
        var brands = new HashSet<string>(StringComparer.Ordinal);
        if (head.Length < 16) return brands;
        var boxSize = (int)Math.Min((uint)(head[0] << 24 | head[1] << 16 | head[2] << 8 | head[3]), (uint)head.Length);
        for (var at = 16; at + 4 <= boxSize; at += 4)
            brands.Add(Encoding.ASCII.GetString(head.Slice(at, 4)));
        return brands;
    }

    private static bool StartsWith(ReadOnlySpan<byte> head, ReadOnlySpan<byte> magic) => head.StartsWith(magic);

    private static bool Ascii(ReadOnlySpan<byte> head, int offset, string magic)
    {
        if (head.Length < offset + magic.Length) return false;
        for (var i = 0; i < magic.Length; i++)
            if (head[offset + i] != (byte)magic[i]) return false;
        return true;
    }

    private static int IndexOf(ReadOnlySpan<byte> head, ReadOnlySpan<byte> needle) => head.IndexOf(needle);
}
