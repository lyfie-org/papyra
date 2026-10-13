using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;

namespace Papyra.Api.Collab;

/// <summary>
/// Edits to a live note from outside its room — a script or AI agent on an API
/// key. Instead of being refused (409 <c>collab_active</c>) they are merged into
/// the room, as long as they say which version they read:
/// <list type="bullet">
///   <item><c>GET /api/notes/{id}</c> answers with an <c>ETag</c> (the body's hash);</item>
///   <item>a write sends it back as <c>If-Match</c>, so the room can merge that
///   version, its own live text and the agent's text three ways;</item>
///   <item>the agent shows in the room's presence under the API key's name, and
///   history credits "Owner via key-name".</item>
/// </list>
/// History stores contributors as ints: a user id, or minus an API key's id.
/// </summary>
public static class LiveAgentEdits
{
    /// <summary>Claims the API-key middleware adds beside the user's own.</summary>
    public const string KeyIdClaim = "papyra:api_key_id";
    public const string KeyNameClaim = "papyra:api_key_name";

    /// <summary>A strong ETag naming one body: what <c>If-Match</c> sends back.</summary>
    public static string ETag(string body) => $"\"{CollabHash.Of(body)}\"";

    /// <summary>The body hash an <c>If-Match</c> names, or null when absent (or <c>*</c>).</summary>
    public static string? IfMatch(HttpRequest request)
    {
        var raw = request.Headers.IfMatch.ToString().Trim();
        if (raw.Length == 0 || raw == "*") return null;
        // One tag is all a note write can mean; take the first of a list.
        var first = raw.Split(',')[0].Trim();
        if (first.StartsWith("W/", StringComparison.Ordinal)) first = first[2..];
        first = first.Trim('"');
        return first.Length == 0 ? null : first;
    }

    /// <summary>412 for a write made against a version that is no longer there.</summary>
    public static IResult Stale(string currentBody) => Results.Json(new
    {
        error = "The note changed since you read it. Re-read it (its ETag) and apply your change again.",
        code = "stale",
        body = currentBody,
        etag = ETag(currentBody),
    }, statusCode: StatusCodes.Status412PreconditionFailed);

    /// <summary>Who the room's presence and history should show for this caller.</summary>
    public static async Task<CollabAgent> AgentAsync(ClaimsPrincipal user, AppDbContext db, CancellationToken ct)
    {
        var uid = int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var me = await db.Users.Where(u => u.Id == uid).Select(u => new { u.Name, u.Username }).FirstAsync(ct);
        var display = string.IsNullOrWhiteSpace(me.Name) ? me.Username : me.Name;
        return int.TryParse(user.FindFirstValue(KeyIdClaim), out var keyId)
            ? new CollabAgent(-keyId, uid, me.Username, user.FindFirstValue(KeyNameClaim) is { Length: > 0 } key ? key : "API key")
            : new CollabAgent(uid, uid, me.Username, display);
    }

    /// <summary>History names for contributor ids: a person, or "Person via key-name".</summary>
    public static async Task<Dictionary<int, string>> NamesAsync(
        AppDbContext db, IReadOnlyCollection<int> contributors, CancellationToken ct)
    {
        var names = new Dictionary<int, string>();
        if (contributors.Count == 0) return names;
        var keyIds = contributors.Where(c => c < 0).Select(c => -c).ToList();
        var keys = keyIds.Count == 0
            ? []
            : await db.ApiKeys.Where(k => keyIds.Contains(k.Id)).Select(k => new { k.Id, k.UserId, k.Name }).ToListAsync(ct);
        var uids = contributors.Where(c => c > 0).Concat(keys.Select(k => k.UserId)).Distinct().ToList();
        var people = await db.Users.Where(u => uids.Contains(u.Id))
            .Select(u => new { u.Id, u.Name, u.Username })
            .ToDictionaryAsync(u => u.Id, u => string.IsNullOrWhiteSpace(u.Name) ? u.Username : u.Name, ct);
        foreach (var (id, name) in people) names[id] = name;
        foreach (var key in keys)
            if (people.TryGetValue(key.UserId, out var person)) names[-key.Id] = $"{person} via {key.Name}";
        return names;
    }

    /// <summary>The account behind a contributor id (a key's owner for a key).</summary>
    public static async Task<int?> AccountOfAsync(AppDbContext db, int contributor, CancellationToken ct) =>
        contributor > 0
            ? contributor
            : await db.ApiKeys.Where(k => k.Id == -contributor).Select(k => (int?)k.UserId).FirstOrDefaultAsync(ct);
}
