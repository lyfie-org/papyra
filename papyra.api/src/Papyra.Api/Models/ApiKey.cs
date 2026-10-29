namespace Papyra.Api.Models;

// A personal access token for the HTTP API. The raw token is shown to the user
// exactly once at creation; only its SHA-256 hash is stored, so a DB leak can't
// reveal usable tokens. `Prefix` is a short non-secret label for the UI list.
public class ApiKey
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    // Short non-secret leading slug (e.g. "papyra_ab12cd") for display only.
    public string Prefix { get; set; } = string.Empty;
    // Hex SHA-256 of the full token — the lookup key on each authenticated request.
    public string TokenHash { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
    // What the key may reach: "notes" (everything but the journal — the default,
    // and what every key made before scopes existed is) or "journal" (the
    // journal API and nothing else). See ApiKeyScopes.
    public string Scope { get; set; } = ApiKeyScopes.Notes;
}

public static class ApiKeyScopes
{
    public const string Notes = "notes";
    public const string Journal = "journal";

    /// <summary>The claim the API-key middleware adds beside the user's own.</summary>
    public const string ClaimType = "papyra:api_key_scope";

    /// <summary>A journal key's visible prefix, so a pasted token is recognisable.</summary>
    public const string JournalTokenPrefix = "papyra_j";

    public static string Normalize(string? scope) =>
        string.Equals(scope?.Trim(), Journal, StringComparison.OrdinalIgnoreCase) ? Journal : Notes;
}
