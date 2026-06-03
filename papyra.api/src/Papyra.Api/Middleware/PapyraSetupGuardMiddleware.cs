using Papyra.Api.Services;

namespace Papyra.Api.Middleware;

// ── PapyraSetupGuardMiddleware ───────────────────────────────────────────────
// Gates ALL API requests with HTTP 428 until the first admin account exists.
// Two endpoints are always permitted through:
//   POST /api/auth/setup  — creates the first admin (obvious necessity)
//   GET  /api/auth/me     — needed by the SPA on first load to detect uninitialized state

public sealed class PapyraSetupGuardMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, UserService users)
    {
        if (!users.IsInitialized() && !IsPermitted(context))
        {
            context.Response.StatusCode  = 428; // Precondition Required
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsJsonAsync(new
            {
                error  = "System not initialized.",
                action = "POST /api/auth/setup to create the first admin account.",
            });
            return;
        }

        await next(context);
    }

    private static bool IsPermitted(HttpContext ctx)
    {
        var method = ctx.Request.Method;
        var path   = ctx.Request.Path.Value ?? string.Empty;

        return (method == "POST" &&
                path.Equals("/api/auth/setup", StringComparison.OrdinalIgnoreCase)) ||
               (method == "GET" &&
                path.Equals("/api/auth/me", StringComparison.OrdinalIgnoreCase));
    }
}
