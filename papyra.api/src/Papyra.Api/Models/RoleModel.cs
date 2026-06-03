namespace Papyra.Api.Models;

public sealed class RoleModel
{
    public required string Name              { get; set; }
    public int   MaxNotesAllowed             { get; set; } = 500;
    public bool  AllowFileUploads            { get; set; } = true;
    public int   AttachmentSizeLimitMB       { get; set; } = 16;
}
