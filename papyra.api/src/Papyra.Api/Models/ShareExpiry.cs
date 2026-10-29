namespace Papyra.Api.Models;

// One definition of "this share has run out", so no path has to remember it.
//
// An expired share is not deleted the moment it expires: a person share stays on
// file so its recipient still sees a card that says it ended (and can clear it),
// and a link share waits for the cleanup sweep. Either way it grants nothing, and
// every route that lets a recipient through to a note must ask here first.
public static class ShareExpiry
{
    public static bool IsExpired(this Share share, DateTime now) =>
        share.ExpiresUtc is { } expires && expires <= now;

    // Shares that still grant access: no expiry, or one that is yet to come.
    public static IQueryable<Share> Live(this IQueryable<Share> shares, DateTime now) =>
        shares.Where(s => s.ExpiresUtc == null || s.ExpiresUtc > now);

    // What a recipient is told when they reach for a note whose share has ended.
    public static IResult Gone() => Results.Json(
        new { error = "This share has expired.", code = "share_expired" },
        statusCode: StatusCodes.Status410Gone);

    // An expiry as the owner typed it, as an instant: a zone-less time is UTC (as
    // the rest of the sharing code already treats it), a local one is converted.
    public static DateTime? AsUtc(DateTime? expires) => expires switch
    {
        null => null,
        { Kind: DateTimeKind.Local } local => local.ToUniversalTime(),
        { } other => DateTime.SpecifyKind(other, DateTimeKind.Utc),
    };
}
