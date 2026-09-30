namespace Papyra.Api.Security;

/// <summary>
/// Carries a vault unlock token to <c>/api/media</c>. Pictures and videos inside
/// a locked note are fetched by <c>&lt;img&gt;</c>/<c>&lt;video&gt;</c> elements,
/// which can't send the <c>X-Unlock-Token</c> header the rest of the vault uses —
/// so each unlock also sets this HttpOnly, SameSite=Strict cookie, scoped to the
/// media path. It holds the same token the header would: validity (expiry, the
/// idle timeout, lock, sign-out) is still decided by the server-side
/// <c>UnlockTokenStore</c>, so the cookie outliving the unlock grants nothing.
/// </summary>
public static class UnlockCookie
{
    public const string Name = "papyra_unlock";
    private const string Path = "/api/media";

    public static void Set(HttpContext http, string token) =>
        http.Response.Cookies.Append(Name, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = http.Request.IsHttps,
            SameSite = SameSiteMode.Strict,
            Path = Path,
            IsEssential = true,
        });

    public static void Clear(HttpContext http) =>
        http.Response.Cookies.Delete(Name, new CookieOptions
        {
            Secure = http.Request.IsHttps,
            SameSite = SameSiteMode.Strict,
            Path = Path,
        });
}
