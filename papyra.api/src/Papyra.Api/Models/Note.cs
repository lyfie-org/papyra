namespace Papyra.Api.Models;

public sealed class Note
{
    public required string Id         { get; init; }
    public required string Title      { get; set; }
    public List<string>    Tags       { get; set; } = [];
    public bool            Pinned     { get; set; }
    public string          Color      { get; set; } = string.Empty;
    public string          Content    { get; set; } = string.Empty;
    public string          Owner      { get; set; } = string.Empty;
    public bool            Archived   { get; set; } = false;
    public bool            Deleted    { get; set; } = false;
    public DateTime        CreatedAt  { get; set; } = DateTime.UtcNow;
    public DateTime        UpdatedAt  { get; set; } = DateTime.UtcNow;
}
