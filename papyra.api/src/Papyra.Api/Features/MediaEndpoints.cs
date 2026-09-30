using System.Security;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Security;
using Papyra.Api.Storage;

namespace Papyra.Api.Features;

public sealed record MediaMetaBatch(string[]? Names);

/// <summary>
/// Attachments: upload, the file itself, its thumbnail and its metadata — for
/// the owner, for a person a note is shared with, and for anyone holding a
/// share link.
///
/// Access rules, in one place:
/// <list type="bullet">
///   <item>The owner reads their own media dir. A file only locked notes embed
///   is part of the vault and needs a live unlock (header, or the media cookie
///   an unlock sets — see <see cref="UnlockCookie"/>).</item>
///   <item>A share (link or person) reaches only the files that shared note
///   embeds, and nothing once the note is locked or gone. A link also stops at
///   its expiry and, once its views are spent, serves only the page load that
///   spent the last one.</item>
/// </list>
/// Every response goes out through <see cref="MediaResponder"/> (originals) or
/// the thumbnail path below, with nosniff and a sandboxed policy.
/// </summary>
public static class MediaEndpoints
{
    public const string UploadRateLimit = "media-upload";

    private const int PosterMaxBytes = 2 * 1024 * 1024;
    private const int MetaPartMaxBytes = 4096;
    private const int MaxBatch = 200;
    private const string Immutable = "private, max-age=31536000, immutable";
    private const string Revalidate = "private, no-cache";

    public static void MapMedia(this WebApplication app)
    {
        // ── Owner ──
        app.MapPost("/api/media/upload", UploadAsync)
            .RequireAuthorization()
            .RequireRateLimiting(UploadRateLimit)
            // The per-kind limits inside do the real policing (by sniffed kind, as
            // bytes arrive); this only lets the largest allowed upload past Kestrel.
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(MediaLimits.Largest + 4 * 1024 * 1024))
            .DisableAntiforgery(); // same-origin SPA; SameSite cookies

        // What the upload will accept, so the web app can say no before sending
        // 600 MB. A literal segment: it outranks `/api/media/{filename}`.
        app.MapGet("/api/media/limits", (HttpResponse response) =>
        {
            response.Headers.CacheControl = "private, max-age=3600";
            return Results.Ok(MediaLimits.Describe());
        }).RequireAuthorization();

        app.MapGet("/api/media/{filename}", (string filename, HttpContext http, MediaReferences refs,
            UnlockTokenStore unlock, IConfiguration config, IHostEnvironment env, ILoggerFactory lf) =>
        {
            var own = ResolveOwn(http, filename, refs, unlock, config, env, lf);
            return own.Error ?? MediaResponder.Serve(http.Response, own.Path!,
                own.VaultOnly ? Revalidate : "private, max-age=3600, must-revalidate");
        }).RequireAuthorization();

        app.MapGet("/api/media/{filename}/thumb", async (string filename, int? w, string? v, HttpContext http,
            MediaReferences refs, MediaMetaStore store, UnlockTokenStore unlock, IConfiguration config,
            IHostEnvironment env, ILoggerFactory lf, CancellationToken ct) =>
        {
            var own = ResolveOwn(http, filename, refs, unlock, config, env, lf);
            if (own.Error is not null) return own.Error;
            return await ThumbAsync(http.Response, Uid(http.User), own.Path!, w, v, store, own.VaultOnly, ct);
        }).RequireAuthorization();

        app.MapGet("/api/media/{filename}/meta", (string filename, HttpContext http, MediaReferences refs,
            MediaMetaStore store, UnlockTokenStore unlock, IConfiguration config, IHostEnvironment env, ILoggerFactory lf) =>
        {
            var own = ResolveOwn(http, filename, refs, unlock, config, env, lf);
            if (own.Error is not null) return own.Error;
            var meta = store.Get(Uid(http.User), own.Path!);
            return meta is null ? Results.NotFound() : Results.Ok(Client(meta));
        }).RequireAuthorization();

        // Batch: the editor asks for every embed's shape at once, before any loads.
        app.MapPost("/api/media/meta", (MediaMetaBatch body, HttpContext http, MediaReferences refs,
            MediaMetaStore store, UnlockTokenStore unlock, IConfiguration config, IHostEnvironment env, ILoggerFactory lf) =>
        {
            var names = Distinct(body.Names);
            if (names is null) return TooMany();
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var name in names)
            {
                var own = ResolveOwn(http, name, refs, unlock, config, env, lf);
                result[name] = own.Error is null && store.Get(Uid(http.User), own.Path!) is { } meta ? Client(meta) : null;
            }
            return Results.Ok(result);
        }).RequireAuthorization();

        // ── Share link (anonymous; the token is the authorisation) ──
        app.MapGet("/api/shared/{token}/media/{filename}", async (string token, string filename, HttpContext http,
            SharedMedia shared, CancellationToken ct) =>
        {
            var hit = await shared.ByLinkAsync(token, filename, http, ct);
            return hit.Error ?? MediaResponder.Serve(http.Response, hit.Path!, Revalidate);
        });
        app.MapGet("/api/shared/{token}/media/{filename}/thumb", async (string token, string filename, int? w,
            HttpContext http, SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var hit = await shared.ByLinkAsync(token, filename, http, ct);
            return hit.Error ?? await ThumbAsync(http.Response, hit.OwnerUid!, hit.Path!, w, null, store, true, ct);
        });
        app.MapGet("/api/shared/{token}/media/{filename}/meta", async (string token, string filename,
            HttpContext http, SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var hit = await shared.ByLinkAsync(token, filename, http, ct);
            if (hit.Error is not null) return hit.Error;
            return store.Get(hit.OwnerUid!, hit.Path!) is { } meta ? Results.Ok(Client(meta)) : Results.NotFound();
        });
        app.MapPost("/api/shared/{token}/media/meta", async (string token, MediaMetaBatch body, HttpContext http,
            SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var names = Distinct(body.Names);
            if (names is null) return TooMany();
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var name in names)
            {
                var hit = await shared.ByLinkAsync(token, name, http, ct);
                if (hit.Status is StatusCodes.Status410Gone) return hit.Error!;
                result[name] = hit.Error is null && store.Get(hit.OwnerUid!, hit.Path!) is { } meta ? Client(meta) : null;
            }
            return Results.Ok(result);
        }).DisableAntiforgery();

        // ── Shared with a person ──
        app.MapGet("/api/shares/incoming/{shareId:int}/media/{filename}", async (int shareId, string filename,
            HttpContext http, SharedMedia shared, CancellationToken ct) =>
        {
            var hit = await shared.ByGrantAsync(shareId, filename, http, ct);
            return hit.Error ?? MediaResponder.Serve(http.Response, hit.Path!, Revalidate);
        }).RequireAuthorization();
        app.MapGet("/api/shares/incoming/{shareId:int}/media/{filename}/thumb", async (int shareId, string filename,
            int? w, HttpContext http, SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var hit = await shared.ByGrantAsync(shareId, filename, http, ct);
            return hit.Error ?? await ThumbAsync(http.Response, hit.OwnerUid!, hit.Path!, w, null, store, true, ct);
        }).RequireAuthorization();
        app.MapGet("/api/shares/incoming/{shareId:int}/media/{filename}/meta", async (int shareId, string filename,
            HttpContext http, SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var hit = await shared.ByGrantAsync(shareId, filename, http, ct);
            if (hit.Error is not null) return hit.Error;
            return store.Get(hit.OwnerUid!, hit.Path!) is { } meta ? Results.Ok(Client(meta)) : Results.NotFound();
        }).RequireAuthorization();
        app.MapPost("/api/shares/incoming/{shareId:int}/media/meta", async (int shareId, MediaMetaBatch body,
            HttpContext http, SharedMedia shared, MediaMetaStore store, CancellationToken ct) =>
        {
            var names = Distinct(body.Names);
            if (names is null) return TooMany();
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var name in names)
            {
                var hit = await shared.ByGrantAsync(shareId, name, http, ct);
                result[name] = hit.Error is null && store.Get(hit.OwnerUid!, hit.Path!) is { } meta ? Client(meta) : null;
            }
            return Results.Ok(result);
        }).RequireAuthorization();
    }

    // ── Upload ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Streams a multipart upload straight to disk: no buffering of the whole
    /// body, one write. Parts, in any order:
    /// <list type="bullet">
    ///   <item><c>file</c> (required) — sniffed from its first bytes, limited by
    ///   that kind as it arrives, SHA-256 hashed on the way through.</item>
    ///   <item><c>poster</c> — a still the browser grabbed from a video (≤ 2 MB,
    ///   PNG/JPEG/WebP only; anything else is ignored).</item>
    ///   <item><c>meta</c> — JSON <c>{width, height, durationMs}</c> the browser
    ///   measured; clamped, and only used where the server can't measure itself.</item>
    /// </list>
    /// </summary>
    private static async Task<IResult> UploadAsync(HttpRequest request, string? noteId, ClaimsPrincipal user,
        MediaMetaStore store, IConfiguration config, IHostEnvironment env, ILoggerFactory lf, CancellationToken ct)
    {
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var contentType)
            || !contentType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "Send the file as multipart/form-data." });
        var boundary = HeaderUtilities.RemoveQuotes(contentType.Boundary).Value;
        if (string.IsNullOrWhiteSpace(boundary) || boundary.Length > 200)
            return Results.BadRequest(new { error = "Malformed upload." });

        var uid = Uid(user);
        var mediaDir = PapyraPaths.UserMediaDir(config, env.ContentRootPath, uid);
        string? tmp = null;
        string? clientName = null;
        SniffedMedia sniffed = default;
        string? hashHex = null;
        long size = 0;
        byte[]? poster = null;
        string? posterExt = null;
        MediaHints? hints = null;

        try
        {
            var reader = new MultipartReader(boundary, request.Body) { HeadersLengthLimit = 16 * 1024 };
            while (await reader.ReadNextSectionAsync(ct) is { } section)
            {
                if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition))
                {
                    await Drain(section.Body, 64 * 1024, ct);
                    continue;
                }
                switch (disposition.Name.Value?.Trim('"'))
                {
                    case "file":
                        if (tmp is not null) return Results.BadRequest(new { error = "One file per upload." });
                        clientName = disposition.FileNameStar.Value ?? disposition.FileName.Value?.Trim('"') ?? "file";

                        var head = new byte[MediaSniffer.HeaderBytes];
                        var headLength = await section.Body.ReadAtLeastAsync(head, head.Length, throwOnEndOfStream: false, ct);
                        sniffed = MediaSniffer.Sniff(head.AsSpan(0, headLength), clientName);
                        var (kindLabel, limit) = MediaLimits.ForKind(sniffed.Kind);

                        Directory.CreateDirectory(mediaDir);
                        tmp = Path.Combine(mediaDir, $"{Guid.NewGuid():N}.tmp");
                        using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                        await using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                                         bufferSize: 81920, useAsync: true))
                        {
                            await fs.WriteAsync(head.AsMemory(0, headLength), ct);
                            hash.AppendData(head, 0, headLength);
                            size = headLength;
                            var buffer = new byte[81920];
                            int read;
                            while ((read = await section.Body.ReadAsync(buffer, ct)) > 0)
                            {
                                size += read;
                                if (size > limit) return TooLarge(kindLabel, limit);
                                await fs.WriteAsync(buffer.AsMemory(0, read), ct);
                                hash.AppendData(buffer, 0, read);
                            }
                            if (size > limit) return TooLarge(kindLabel, limit);
                            await fs.FlushAsync(ct);
                            hashHex = Convert.ToHexStringLower(hash.GetHashAndReset());
                        }
                        break;

                    case "poster":
                        var posterBytes = await ReadCapped(section.Body, PosterMaxBytes, ct);
                        if (posterBytes is null) break; // too big: ignored, never fatal
                        var posterKind = MediaSniffer.Sniff(posterBytes, "poster");
                        if (posterKind.Extension is ".webp" or ".jpg" or ".png")
                            (poster, posterExt) = (posterBytes, posterKind.Extension);
                        break;

                    case "meta":
                        var metaBytes = await ReadCapped(section.Body, MetaPartMaxBytes, ct);
                        if (metaBytes is not null) hints = ParseHints(metaBytes);
                        break;

                    default:
                        await Drain(section.Body, 64 * 1024, ct);
                        break;
                }
            }

            if (tmp is null || size == 0) return Results.BadRequest(new { error = "No file." });

            // A readable name — the original's, slugged — plus a short suffix so
            // two pasted "image.png"s never clobber each other: `airway-bill-3f9a2c.jpg`.
            // The extension is the sniffed one, never the client's.
            var slug = NoteFileNamer.Slug(Path.GetFileNameWithoutExtension(clientName ?? "file"));
            if (slug.Length == 0) slug = "file";
            if (slug.Length > 48) slug = slug[..48].TrimEnd('-');
            var filename = $"{slug}-{Guid.NewGuid().ToString("N")[..6]}{sniffed.Extension}";
            var dest = PathGuard.ResolveAndVerify(mediaDir, filename, lf.CreateLogger("PathGuard"));
            File.Move(tmp, dest);
            tmp = null;

            if (poster is not null && sniffed.Kind == "video") store.SavePoster(uid, filename, poster, posterExt!);
            var meta = store.Record(uid, dest, hashHex!, hints, hasPoster: poster is not null && sniffed.Kind == "video");
            return Results.Ok(new
            {
                filename,
                meta.Kind, meta.Mime, meta.Size, meta.Version,
                meta.Width, meta.Height, meta.DurationMs, meta.Animated, meta.Poster, meta.Thumb,
            });
        }
        catch (InvalidDataException)
        {
            return Results.BadRequest(new { error = "Malformed upload." });
        }
        catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return TooLarge("file", MediaLimits.Largest);
        }
        finally
        {
            // A cancelled, refused or failed upload leaves nothing behind for
            // export and backups to pick up.
            if (tmp is not null)
                try { File.Delete(tmp); } catch (IOException) { }
        }
    }

    private static IResult TooLarge(string kindLabel, long limit) => Results.Json(new
    {
        error = $"That {kindLabel} is over the {MediaLimits.Human(limit)} limit for {kindLabel}s.",
        code = "too_large",
        limit,
    }, statusCode: StatusCodes.Status413PayloadTooLarge);

    private static IResult TooMany() =>
        Results.BadRequest(new { error = $"Ask for at most {MaxBatch} files at once." });

    private static MediaHints? ParseHints(byte[] json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            static long? Num(JsonElement e, string name) =>
                e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d)
                    && double.IsFinite(d) && d > 0 && d < long.MaxValue ? (long)d : null;
            var w = Num(root, "width");
            var h = Num(root, "height");
            return new MediaHints(
                w is > 0 and <= 16384 ? (int)w : null,
                h is > 0 and <= 16384 ? (int)h : null,
                Num(root, "durationMs"));
        }
        catch (JsonException) { return null; }
    }

    private static async Task<byte[]?> ReadCapped(Stream body, int max, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await body.ReadAsync(buffer, ct)) > 0)
        {
            if (ms.Length + read > max)
            {
                await Drain(body, long.MaxValue, ct);
                return null;
            }
            ms.Write(buffer, 0, read);
        }
        return ms.ToArray();
    }

    private static async Task Drain(Stream body, long max, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(buffer, ct)) > 0)
            if ((total += read) > max) throw new InvalidDataException("Unexpected part.");
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    private readonly record struct OwnHit(string? Path, bool VaultOnly, IResult? Error);

    private static OwnHit ResolveOwn(HttpContext http, string filename, MediaReferences refs, UnlockTokenStore unlock,
        IConfiguration config, IHostEnvironment env, ILoggerFactory lf)
    {
        var uid = Uid(http.User);
        var path = Locate(PapyraPaths.UserMediaDir(config, env.ContentRootPath, uid), filename, lf);
        if (path is null) return new(null, false, Results.NotFound());

        var name = System.IO.Path.GetFileName(path);
        var referrers = refs.Referrers(uid, name).ToList();
        var vaultOnly = referrers.Count > 0 && referrers.All(n => n.Secure);
        if (vaultOnly)
        {
            var token = http.Request.Headers["X-Unlock-Token"].ToString();
            if (token.Length == 0) token = http.Request.Cookies[UnlockCookie.Name] ?? string.Empty;
            if (IsApiKey(http.User) || !unlock.IsValid(token, uid))
                return new(null, true, Results.Json(new { error = "Unlock required.", code = "locked" },
                    statusCode: StatusCodes.Status401Unauthorized));
        }
        return new(path, vaultOnly, null);
    }

    /// <summary>
    /// The file for <paramref name="filename"/> in <paramref name="mediaDir"/>,
    /// jailed there by PathGuard. Falls back to a case-insensitive match: an
    /// Obsidian vault embeds <c>![[Photo.PNG]]</c> for <c>photo.png</c>, and on
    /// Linux the exact lookup misses.
    /// </summary>
    internal static string? Locate(string mediaDir, string filename, ILoggerFactory lf)
    {
        if (string.IsNullOrWhiteSpace(filename) || filename.Length > 255
            || filename.IndexOfAny(['/', '\\', '\0']) >= 0 || filename is "." or "..") return null;
        string dest;
        try { dest = PathGuard.ResolveAndVerify(mediaDir, filename, lf.CreateLogger("PathGuard")); }
        catch (SecurityException) { return null; }
        if (File.Exists(dest)) return dest;
        if (!Directory.Exists(mediaDir)) return null;
        return Directory.EnumerateFiles(mediaDir)
            .FirstOrDefault(f => string.Equals(System.IO.Path.GetFileName(f), filename, StringComparison.OrdinalIgnoreCase)
                && !f.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase));
    }

    private static async Task<IResult> ThumbAsync(HttpResponse response, string ownerUid, string path, int? w, string? v,
        MediaMetaStore store, bool revalidate, CancellationToken ct)
    {
        var meta = store.Get(ownerUid, path);
        if (meta is null) return Results.NotFound();
        var width = MediaMetaStore.SnapWidth(w);
        var thumb = await store.ThumbnailAsync(ownerUid, path, meta, width, ct);
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.ContentSecurityPolicy = MediaResponder.SandboxPolicy;
        if (thumb is null)
        {
            // Nothing this server can draw (SVG, HEIC, audio, a document, a video
            // with no poster). The client falls back to the original or a card.
            response.Headers["X-Papyra-Reason"] = "unsupported";
            return Results.NotFound();
        }
        // A URL that names the content version can never change: cache it for a
        // year. Anything else — and anything shared or in the vault — revalidates.
        response.Headers.CacheControl = !revalidate && v == meta.Version ? Immutable : Revalidate;
        return Results.File(thumb, "image/webp",
            lastModified: File.GetLastWriteTimeUtc(thumb),
            entityTag: new EntityTagHeaderValue($"\"{meta.Version}-{width}\""));
    }

    private static object Client(MediaMeta m) => new
    {
        m.Name, m.Kind, m.Mime, m.Size, m.Version,
        m.Width, m.Height, m.DurationMs, m.Animated, m.Poster, m.Thumb,
    };

    private static string[]? Distinct(string[]? names)
    {
        var list = (names ?? []).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.Ordinal).ToArray();
        return list.Length > MaxBatch ? null : list;
    }

    private static string Uid(ClaimsPrincipal user) =>
        user.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? throw new SecurityException("Authenticated principal carries no user id.");

    private static bool IsApiKey(ClaimsPrincipal user) => user.Identity?.AuthenticationType == "ApiKey";
}

/// <summary>
/// Resolves an attachment through a share. Scoped (it holds the request's
/// <see cref="AppDbContext"/>); caches the share and its note per request so a
/// batch of 200 names reads them once.
/// </summary>
public sealed class SharedMedia(
    AppDbContext db, IDataProtectionProvider dataProtection, VaultState state, MarkdownStorageService storage,
    VaultObserverOptions vault, MediaReferences refs, IConfiguration config, IHostEnvironment env, ILoggerFactory lf)
{
    public readonly record struct Hit(string? Path, string? OwnerUid, IResult? Error, int Status);

    private (string Key, Share? Share, Note? Note, Hit? Refusal)? _resolved;

    public async Task<Hit> ByLinkAsync(string token, string filename, HttpContext http, CancellationToken ct)
    {
        var key = "link:" + token;
        if (_resolved?.Key != key)
        {
            var share = await db.Shares.FirstOrDefaultAsync(s => s.Token == token && s.Kind == "link", ct);
            Hit? refusal = null;
            if (share is null) refusal = NotFound();
            else if (share.ExpiresUtc is { } exp && exp < DateTime.UtcNow)
                refusal = Gone("This link has expired.");
            else if (share.MaxViews is { } mv && share.ViewCount >= mv && !HoldsCountedView(share, token, http))
                refusal = Gone("This link has reached its view limit.");
            _resolved = (key, share, refusal is null ? await NoteOf(share!, ct) : null, refusal);
        }
        return Resolve(filename);
    }

    public async Task<Hit> ByGrantAsync(int shareId, string filename, HttpContext http, CancellationToken ct)
    {
        var key = "grant:" + shareId;
        if (_resolved?.Key != key)
        {
            var uid = int.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
            var share = await db.Shares.FirstOrDefaultAsync(s => s.Id == shareId && s.GranteeUserId == uid, ct);
            _resolved = (key, share, share is null ? null : await NoteOf(share, ct), share is null ? NotFound() : null);
        }
        return Resolve(filename);
    }

    private Hit Resolve(string filename)
    {
        var (_, share, note, refusal) = _resolved!.Value;
        if (refusal is { } r) return r;
        // Locked since it was shared: its attachments stay in the vault with its
        // body. Gone, or never embedded in it: not this share's to hand out.
        if (share is null || note is null || note.Secure) return NotFound();
        var owner = share.OwnerId.ToString();
        var path = MediaEndpoints.Locate(PapyraPaths.UserMediaDir(config, env.ContentRootPath, owner), filename, lf);
        if (path is null || !refs.References(note, Path.GetFileName(path))) return NotFound();
        return new Hit(path, owner, null, StatusCodes.Status200OK);
    }

    private async Task<Note?> NoteOf(Share share, CancellationToken ct)
    {
        var owner = share.OwnerId.ToString();
        string path;
        try
        {
            path = state.PathFor(owner, share.NoteId)
                ?? PathGuard.ResolveAndVerify(vault.UserNotesDir(owner), $"{share.NoteId}.md", lf.CreateLogger("PathGuard"));
        }
        catch (SecurityException) { return null; }
        return await storage.ReadAsync(path, ct);
    }

    // Once a limited link has used its views, only the page load that was itself
    // counted (it holds the signed view cookie, scoped to this link's path) may
    // still fetch the note's pictures.
    private bool HoldsCountedView(Share share, string token, HttpContext http)
    {
        if (!http.Request.Cookies.TryGetValue($"papyra_view_{share.Id}", out var cookie)) return false;
        try
        {
            var viewer = dataProtection.CreateProtector("Papyra.SharedLinkView.v2").ToTimeLimitedDataProtector();
            return viewer.Unprotect(cookie).StartsWith($"{share.Id}:{token}:", StringComparison.Ordinal);
        }
        catch (CryptographicException) { return false; }
    }

    private static Hit NotFound() => new(null, null, Results.NotFound(), StatusCodes.Status404NotFound);

    private static Hit Gone(string error) => new(null, null,
        Results.Json(new { error }, statusCode: StatusCodes.Status410Gone), StatusCodes.Status410Gone);
}
