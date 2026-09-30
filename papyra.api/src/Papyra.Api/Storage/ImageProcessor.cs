using SkiaSharp;

namespace Papyra.Api.Storage;

/// <summary>What a picture is, as a viewer will see it (EXIF rotation applied).</summary>
public readonly record struct ImageProbe(int Width, int Height, bool Animated);

/// <summary>
/// Reads and resizes pictures with SkiaSharp. Everything here is defensive: the
/// input is whatever a user uploaded, so a file that won't decode, is absurdly
/// large, or lies in its header yields <c>null</c> — never an exception, and
/// never an unbounded allocation.
/// </summary>
public static class ImageProcessor
{
    /// <summary>
    /// Refuse to decode anything that would need more than this many pixels in
    /// memory (after the codec's own downscaling). ~64 MP is a 256 MB bitmap: a
    /// "decompression bomb" — a tiny PNG claiming 100k×100k — stops here.
    /// </summary>
    private const long MaxDecodePixels = 64L * 1024 * 1024;

    private static readonly HashSet<string> Decodable = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif" };

    private static readonly Lazy<bool> NativeReady = new(() =>
    {
        try
        {
            using var probe = new SKBitmap(1, 1);
            using var image = SKImage.FromBitmap(probe);
            using var data = image.Encode(SKEncodedImageFormat.Webp, 50);
            return data is not null;
        }
        catch (Exception) { return false; }
    });

    /// <summary>
    /// Whether the native Skia library loaded on this platform. When it didn't
    /// (an unsupported libc, a stripped image), thumbnails and picture metadata
    /// simply aren't offered — originals still serve — and /health says so.
    /// </summary>
    public static bool Available => NativeReady.Value;

    /// <summary>Whether this server can read the format at all (HEIC and TIFF: no).</summary>
    public static bool CanDecode(string path) => Decodable.Contains(Path.GetExtension(path)) && Available;

    /// <summary>Dimensions (upright) and whether it animates. Reads the header only.</summary>
    public static ImageProbe? Probe(string path)
    {
        if (!CanDecode(path)) return null;
        try
        {
            using var codec = SKCodec.Create(path);
            if (codec is null) return null;
            var (w, h) = (codec.Info.Width, codec.Info.Height);
            if (w <= 0 || h <= 0) return null;
            if (SwapsAxes(codec.EncodedOrigin)) (w, h) = (h, w);
            return new ImageProbe(w, h, codec.FrameCount > 1);
        }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// Write an upright WebP of <paramref name="source"/> at most
    /// <paramref name="maxWidth"/> wide (never upscaled) to <paramref name="dest"/>,
    /// atomically. Only pixels are re-encoded, so EXIF — GPS, camera serials — is
    /// gone. An animated GIF/WebP yields its first frame. False when the source
    /// can't be decoded safely.
    /// </summary>
    public static bool WriteThumbnail(string source, int maxWidth, string dest, int quality = 78)
    {
        if (!CanDecode(source)) return false;
        try
        {
            using var codec = SKCodec.Create(source);
            if (codec is null) return false;
            var origin = codec.EncodedOrigin;
            var swaps = SwapsAxes(origin);
            var info = codec.Info;
            var uprightWidth = swaps ? info.Height : info.Width;
            if (info.Width <= 0 || info.Height <= 0) return false;

            // Ask the codec for the smallest size it can decode that still covers
            // the target (JPEG decodes at 1/2, 1/4, 1/8 for almost nothing).
            var targetWidth = Math.Min(maxWidth, uprightWidth);
            var scale = Math.Min(1f, (float)targetWidth / uprightWidth);
            var decodeSize = codec.GetScaledDimensions(scale);
            if (decodeSize.Width <= 0 || decodeSize.Height <= 0) decodeSize = info.Size;
            if ((long)decodeSize.Width * decodeSize.Height > MaxDecodePixels) return false;

            var decodeInfo = new SKImageInfo(decodeSize.Width, decodeSize.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
            var decoded = new SKBitmap(decodeInfo);
            var result = codec.GetPixels(decodeInfo, decoded.GetPixels());
            if (result == SKCodecResult.InvalidScale && decodeSize != info.Size)
            {
                // Not every codec scales while decoding: fall back to full size.
                decoded.Dispose();
                if ((long)info.Width * info.Height > MaxDecodePixels) return false;
                decodeInfo = new SKImageInfo(info.Width, info.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
                decoded = new SKBitmap(decodeInfo);
                result = codec.GetPixels(decodeInfo, decoded.GetPixels());
            }
            using var _ = decoded;
            if (result is not (SKCodecResult.Success or SKCodecResult.IncompleteInput)) return false;

            using var upright = Orient(decoded, origin);
            var targetHeight = Math.Max(1, (int)Math.Round((double)upright.Height * targetWidth / upright.Width));
            using var resized = upright.Width == targetWidth && upright.Height == targetHeight
                ? upright.Copy()
                : upright.Resize(new SKImageInfo(targetWidth, targetHeight, SKColorType.Rgba8888, SKAlphaType.Premul),
                    new SKSamplingOptions(SKCubicResampler.Mitchell));
            if (resized is null) return false;

            using var image = SKImage.FromBitmap(resized);
            using var data = image.Encode(SKEncodedImageFormat.Webp, quality);
            if (data is null) return false;

            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            var tmp = dest + $".{Guid.NewGuid():N}.tmp";
            try
            {
                using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    data.SaveTo(fs);
                    fs.Flush(true);
                }
                File.Move(tmp, dest, overwrite: true);
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
            return true;
        }
        catch (Exception) { return false; }
    }

    private static bool SwapsAxes(SKEncodedOrigin origin) =>
        origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop
            or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;

    // Redraw the decoded pixels the way the EXIF orientation says to show them.
    private static SKBitmap Orient(SKBitmap source, SKEncodedOrigin origin)
    {
        if (origin == SKEncodedOrigin.TopLeft) return source.Copy();
        float w = source.Width, h = source.Height;
        var swap = SwapsAxes(origin);
        // x' = scaleX·x + skewX·y + transX ; y' = skewY·x + scaleY·y + transY
        var matrix = origin switch
        {
            SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
            SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1),
            SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),
            _ => SKMatrix.Identity,
        };
        var result = new SKBitmap(new SKImageInfo(
            swap ? source.Height : source.Width, swap ? source.Width : source.Height,
            SKColorType.Rgba8888, SKAlphaType.Premul));
        using var canvas = new SKCanvas(result);
        canvas.Clear(SKColors.Transparent);
        canvas.SetMatrix(matrix);
        using var image = SKImage.FromBitmap(source);
        // Quarter turns and flips land exactly on pixels: no filtering needed.
        canvas.DrawImage(image, 0, 0, new SKSamplingOptions(SKFilterMode.Nearest));
        canvas.Flush();
        return result;
    }
}
