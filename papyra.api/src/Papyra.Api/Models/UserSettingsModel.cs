namespace Papyra.Api.Models;

public sealed class UserSettingsModel
{
    public string       Theme              { get; set; } = "light";
    public string       EditorPadding      { get; set; } = "normal";
    public string       SidebarLayout      { get; set; } = "default";
    public string       ViewMode           { get; set; } = "grid";
    public List<string> PinnedSharedNotes  { get; set; } = [];
}
