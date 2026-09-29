using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Security;

/// <summary>
/// Signed-in browsers, one <see cref="UserSession"/> row each. The cookie
/// carries a random session id (the <c>sid</c> claim); only its hash is stored,
/// and every request checks the row — so ending a session from Settings works on
/// the next request, and a stolen database can't mint cookies.
///
/// "Remember this device" makes the cookie outlive the browser (30 days,
/// sliding); otherwise it ends when the browser closes, with a week's cap.
/// </summary>
public static class Sessions
{
    public const string ClaimType = "sid";
    public static readonly TimeSpan RememberFor = TimeSpan.FromDays(30);
    public static readonly TimeSpan DefaultFor = TimeSpan.FromDays(7);
    /// <summary>How stale "last active" may get before a request refreshes it.</summary>
    public static readonly TimeSpan TouchEvery = TimeSpan.FromMinutes(5);

    public static string Hash(string sid) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid))).ToLowerInvariant();

    public static string? CurrentSid(ClaimsPrincipal principal) => principal.FindFirstValue(ClaimType);

    /// <summary>
    /// Start a session (or, for a caller already signed in as this account,
    /// re-issue the cookie on the same session — a rename re-signs without
    /// leaving an orphan row behind).
    /// </summary>
    public static async Task SignInAsync(
        HttpContext http, AppDbContext db, User user, bool remember, string method, CancellationToken ct = default)
    {
        UserSession? row = null;
        if (CurrentSid(http.User) is { } existing
            && http.User.FindFirstValue(ClaimTypes.NameIdentifier) == user.Id.ToString())
        {
            var hash = Hash(existing);
            row = await db.UserSessions.FirstOrDefaultAsync(s => s.SessionHash == hash && s.UserId == user.Id, ct);
            if (row is not null)
            {
                await IssueCookieAsync(http, user, existing, row.Remember);
                return;
            }
        }

        var sid = await CreateAsync(http, db, user, remember, method, ct);
        await IssueCookieAsync(http, user, sid, remember);
    }

    /// <summary>A new session row; returns the id for the cookie.</summary>
    public static async Task<string> CreateAsync(
        HttpContext http, AppDbContext db, User user, bool remember, string method, CancellationToken ct = default)
    {
        var sid = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var now = DateTime.UtcNow;
        db.UserSessions.Add(new UserSession
        {
            UserId = user.Id,
            SessionHash = Hash(sid),
            Label = SignInNotices.Describe(http.Request.Headers.UserAgent.ToString()),
            LastIp = http.Connection.RemoteIpAddress?.ToString(),
            Method = method,
            Remember = remember,
            CreatedUtc = now,
            LastSeenUtc = now,
            ExpiresUtc = now + (remember ? RememberFor : DefaultFor),
        });
        // Expired rows go whenever anyone signs in; there is no need for a job.
        db.UserSessions.RemoveRange(db.UserSessions.Where(s => s.UserId == user.Id && s.ExpiresUtc < now));
        await db.SaveChangesAsync(ct);
        return sid;
    }

    public static ClaimsPrincipal Principal(User user, string sid) => new(new ClaimsIdentity(
    [
        new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
        new Claim(ClaimTypes.Name, user.Username),
        new Claim(ClaimTypes.Role, user.Role),
        new Claim(ClaimType, sid),
    ], CookieAuthenticationDefaults.AuthenticationScheme));

    public static Task IssueCookieAsync(HttpContext http, User user, string sid, bool remember) =>
        http.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, Principal(user, sid), Properties(remember));

    public static AuthenticationProperties Properties(bool remember) => new()
    {
        // Persistent = survives closing the browser. Either way the ticket
        // slides, keeping the span it was issued with.
        IsPersistent = remember,
        IssuedUtc = DateTimeOffset.UtcNow,
        ExpiresUtc = DateTimeOffset.UtcNow + (remember ? RememberFor : DefaultFor),
        AllowRefresh = true,
    };

    /// <summary>Sign every session of an account out, except (optionally) the caller's own.</summary>
    public static async Task RevokeAllAsync(AppDbContext db, int userId, string? keepSid = null, CancellationToken ct = default)
    {
        var keep = keepSid is null ? null : Hash(keepSid);
        await db.UserSessions.Where(s => s.UserId == userId && s.SessionHash != keep).ExecuteDeleteAsync(ct);
    }
}
