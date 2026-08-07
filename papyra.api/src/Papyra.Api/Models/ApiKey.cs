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
}
