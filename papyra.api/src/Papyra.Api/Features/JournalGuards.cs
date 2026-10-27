namespace Papyra.Api.Features;

/// <summary>Refusals for the generic note routes when they're pointed at a journal entry.</summary>
public static class JournalGuards
{
    public static IResult NotHere() => Results.Json(
        new { error = "Journal entries are written through the journal.", code = "journal_entry" },
        statusCode: StatusCodes.Status409Conflict);
}
