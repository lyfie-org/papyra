using Papyra.Api.Storage;

namespace Papyra.Api.Features;

/// <summary>Refusals for the generic note routes when they're pointed at a journal entry.</summary>
public static class JournalGuards
{
    /// <summary>The person switched their journal off: every journal route but its settings answers this.</summary>
    public static IResult Off() => Results.Json(
        new { error = "The journal is off.", code = "journal_off" },
        statusCode: StatusCodes.Status404NotFound);

    public static IResult NotHere() => Results.Json(
        new { error = "Journal entries are written through the journal.", code = "journal_entry" },
        statusCode: StatusCodes.Status409Conflict);
}

/// <summary>
/// Answers 404 <c>journal_off</c> for a person who switched their journal off — the browser and
/// journal-scoped keys alike, so an agent can't write into a hidden journal. Not applied to the
/// settings routes (they hold the switch) or the export (a person can always take their data).
/// </summary>
public sealed class JournalOnFilter(JournalSettings settings) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var uid = context.HttpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        if (uid is not null && !settings.IsEnabled(uid)) return JournalGuards.Off();
        return await next(context);
    }
}
