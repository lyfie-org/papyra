using System.Text;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

public sealed class MarkdownStorageService : IMarkdownStorageService
{
    public string SerializeNote(Note note)
    {
        var sb = new StringBuilder();
        sb.Append("---\n");
        sb.Append($"id: {note.Id}\n");
        sb.Append($"title: \"{EscapeYamlString(note.Title)}\"\n");
        sb.Append("tags: [");
        sb.Append(string.Join(",", note.Tags.Select(t => $"\"{EscapeYamlString(t)}\"")));
        sb.Append("]\n");
        sb.Append($"pinned: {(note.Pinned ? "true" : "false")}\n");
        sb.Append($"color: \"{note.Color}\"\n");
        sb.Append($"owner: {note.Owner}\n");
        sb.Append($"archived: {(note.Archived ? "true" : "false")}\n");
        sb.Append($"deleted: {(note.Deleted ? "true" : "false")}\n");
        sb.Append($"created_at: {note.CreatedAt:O}\n");
        sb.Append($"updated_at: {note.UpdatedAt:O}\n");
        sb.Append("---\n");
        sb.Append(note.Content);
        return sb.ToString();
    }

    public Note DeserializeNote(string fileContent)
    {
        var lines = fileContent.ReplaceLineEndings("\n").Split('\n');

        if (lines.Length == 0 || lines[0] != "---")
            throw new FormatException("File must begin with YAML frontmatter delimiter '---'.");

        int closeIdx = -1;
        for (int i = 1; i < lines.Length; i++)
        {
            if (lines[i] == "---")
            {
                closeIdx = i;
                break;
            }
        }

        if (closeIdx < 0)
            throw new FormatException("Missing closing YAML frontmatter delimiter '---'.");

        string id = string.Empty, title = string.Empty, color = string.Empty, owner = string.Empty;
        List<string> tags = [];
        bool pinned = false, archived = false, deleted = false;
        DateTime createdAt = DateTime.UtcNow, updatedAt = DateTime.UtcNow;

        foreach (var line in lines[1..closeIdx])
        {
            var colonIdx = line.IndexOf(':');
            if (colonIdx < 0) continue;
            var key   = line[..colonIdx].Trim();
            var value = line[(colonIdx + 1)..].Trim();

            switch (key)
            {
                case "id":          id         = value; break;
                case "title":       title      = StripYamlQuotes(value); break;
                case "tags":        tags       = ParseTagsArray(value); break;
                case "pinned":      pinned     = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "color":       color      = StripYamlQuotes(value); break;
                case "owner":       owner      = value; break;
                case "archived":    archived   = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "deleted":     deleted    = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "created_at":  if (DateTime.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var ca)) createdAt = ca; break;
                case "updated_at":  if (DateTime.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var ua)) updatedAt = ua; break;
            }
        }

        var content = string.Join("\n", lines[(closeIdx + 1)..]);

        return new Note
        {
            Id         = id,
            Title      = title,
            Tags       = tags,
            Pinned     = pinned,
            Color      = color,
            Content    = content,
            Owner      = owner,
            Archived   = archived,
            Deleted    = deleted,
            CreatedAt  = createdAt,
            UpdatedAt  = updatedAt,
        };
    }

    // Stream-reads only the YAML frontmatter block — stops at the closing ---.
    // Does not read, buffer, or allocate the note body.
    public NoteMetadata ParseFrontmatterOnly(Stream stream)
    {
        using var reader = new StreamReader(stream, leaveOpen: true);

        if (reader.ReadLine() != "---")
            throw new FormatException("File must begin with YAML frontmatter delimiter '---'.");

        string id = string.Empty, title = string.Empty, color = string.Empty, owner = string.Empty;
        List<string> tags = [];
        bool pinned = false, archived = false, deleted = false;
        var createdAt = DateTime.UtcNow;
        var updatedAt = DateTime.UtcNow;

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line == "---") break;

            var colonIdx = line.IndexOf(':');
            if (colonIdx < 0) continue;
            var key   = line[..colonIdx].Trim();
            var value = line[(colonIdx + 1)..].Trim();

            switch (key)
            {
                case "id":         id       = value; break;
                case "title":      title    = StripYamlQuotes(value); break;
                case "tags":       tags     = ParseTagsArray(value); break;
                case "pinned":     pinned   = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "color":      color    = StripYamlQuotes(value); break;
                case "owner":      owner    = value; break;
                case "archived":   archived = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "deleted":    deleted  = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "created_at":
                    if (DateTime.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var ca))
                        createdAt = ca;
                    break;
                case "updated_at":
                    if (DateTime.TryParse(value, null, System.Globalization.DateTimeStyles.RoundtripKind, out var ua))
                        updatedAt = ua;
                    break;
            }
        }

        return new NoteMetadata(id, title, tags, pinned, color, owner, archived, deleted, createdAt, updatedAt);
    }

    private static string EscapeYamlString(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static string StripYamlQuotes(string value)
    {
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            return value[1..^1].Replace("\\\"", "\"").Replace("\\\\", "\\");
        return value;
    }

    private static List<string> ParseTagsArray(string value)
    {
        value = value.Trim();
        if (value is "[]" or "") return [];
        if (value.StartsWith('[') && value.EndsWith(']'))
            value = value[1..^1];
        return [.. value.Split(',')
            .Select(t => StripYamlQuotes(t.Trim()))
            .Where(t => t.Length > 0)];
    }
}
