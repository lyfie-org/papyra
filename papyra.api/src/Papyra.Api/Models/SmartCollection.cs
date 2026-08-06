namespace Papyra.Api.Models;

// A saved search ("smart collection"): a named set of AND/OR rules over note
// metadata. Membership is computed live from the vault — notes are never moved, so
// they still appear on the main feed. RulesJson holds the serialized rule set.
public class SmartCollection
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string RulesJson { get; set; } = string.Empty;
    public DateTime CreatedUtc { get; set; }
}
