namespace Papyra.Api.Models;

// Tenant identity. Auth (BCrypt hash, cookie sessions) wired in Phase 6.
public class User
{
    public int Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Role { get; set; } = "User";
    // The external IdP subject for SSO-provisioned users (OIDC `sub`). Null for
    // local password accounts; unique when set so one IdP identity maps to one user.
    public string? ExternalId { get; set; }
}
