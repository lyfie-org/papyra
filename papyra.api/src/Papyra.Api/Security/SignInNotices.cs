using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;
using Papyra.Api.Storage;

namespace Papyra.Api.Security;

/// <summary>
/// Remembers which browsers have signed in to an account, and tells the owner when
/// one it has never seen does. A browser is recognised by a random id in a
/// long-lived, HttpOnly cookie — not by its user-agent or address, which change
/// with every update and every café.
///
/// The very first device an account records is never "new": that is the owner
/// setting up, or an existing account's first sign-in after this shipped, and
/// warning about it would teach people to ignore the warning.
/// </summary>
public static class SignInNotices
{
    public const string CookieName = "papyra.device";

    public static async Task RecordAsync(
        HttpContext http, AppDbContext db, EmailSender email, User user, string method, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        user.LastSignInUtc = now;

        var id = http.Request.Cookies[CookieName];
        if (string.IsNullOrEmpty(id) || id.Length is < 16 or > 128)
        {
            id = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        }
        http.Response.Cookies.Append(CookieName, id, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Secure = http.Request.IsHttps,
            MaxAge = TimeSpan.FromDays(400),
            IsEssential = true,
        });

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();
        var ip = http.Connection.RemoteIpAddress?.ToString();
        var label = Describe(http.Request.Headers.UserAgent.ToString());

        var device = await db.KnownDevices.FirstOrDefaultAsync(d => d.UserId == user.Id && d.DeviceHash == hash, ct);
        var isNew = false;
        if (device is null)
        {
            isNew = await db.KnownDevices.AnyAsync(d => d.UserId == user.Id, ct);
            db.KnownDevices.Add(new KnownDevice
            {
                UserId = user.Id, DeviceHash = hash, Label = label, LastIp = ip,
                FirstSeenUtc = now, LastSeenUtc = now,
            });
        }
        else
        {
            device.LastSeenUtc = now;
            device.LastIp = ip;
            device.Label = label;
        }
        await db.SaveChangesAsync(ct);

        if (!isNew) return;
        await email.NotifyAsync(user, NotificationCatalog.NewSignIn,
            "New sign-in to your Papyra account",
            $"Your account \"{user.Username}\" was just signed in to from a browser it hasn't seen before.\n\n"
            + "If this was you, there's nothing to do. If it wasn't, change your password now and ask your "
            + "Papyra administrator to check the account.",
            [
                new("When", When(user, now)),
                new("Browser", label),
                new("Address", ip ?? "unknown"),
                new("Signed in with", method),
            ], ct);
    }

    /// <summary>A moment in the person's own time zone, for the details table of an email.</summary>
    public static string When(User user, DateTime utc)
    {
        var zone = TimeZoneInfo.Local;
        if (!string.IsNullOrEmpty(user.TimeZone) && TimeZoneInfo.TryFindSystemTimeZoneById(user.TimeZone, out var tz)) zone = tz;
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), zone);
        return $"{local:ddd d MMM yyyy, HH:mm} ({zone.Id})";
    }

    /// <summary>"Firefox on macOS" from a user-agent string — enough to recognise, not to fingerprint.</summary>
    public static string Describe(string userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent)) return "Unknown browser";
        var ua = userAgent;
        var browser =
            ua.Contains("Edg/") ? "Edge"
            : ua.Contains("OPR/") ? "Opera"
            : ua.Contains("Firefox/") ? "Firefox"
            : ua.Contains("Chrome/") ? "Chrome"
            : ua.Contains("Safari/") ? "Safari"
            : ua.Contains("okhttp") || ua.Contains("Expo") ? "Papyra app"
            : "A browser";
        var os =
            ua.Contains("iPhone") || ua.Contains("iPad") ? "iOS"
            : ua.Contains("Android") ? "Android"
            : ua.Contains("Windows") ? "Windows"
            : ua.Contains("Mac OS X") || ua.Contains("Macintosh") ? "macOS"
            : ua.Contains("CrOS") ? "ChromeOS"
            : ua.Contains("Linux") ? "Linux"
            : null;
        return os is null ? browser : $"{browser} on {os}";
    }
}
