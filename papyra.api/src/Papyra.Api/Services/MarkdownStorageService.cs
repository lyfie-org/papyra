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

        string id = string.Empty, title = string.Empty, color = string.Empty;
        List<string> tags = [];
        bool pinned = false;

        foreach (var line in lines[1..closeIdx])
        {
            var colonIdx = line.IndexOf(':');
            if (colonIdx < 0) continue;
            var key = line[..colonIdx].Trim();
            var value = line[(colonIdx + 1)..].Trim();

            switch (key)
            {
                case "id":     id = value; break;
                case "title":  title = StripYamlQuotes(value); break;
                case "tags":   tags = ParseTagsArray(value); break;
                case "pinned": pinned = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                case "color":  color = StripYamlQuotes(value); break;
            }
        }

        var content = string.Join("\n", lines[(closeIdx + 1)..]);

        return new Note
        {
            Id = id,
            Title = title,
            Tags = tags,
            Pinned = pinned,
            Color = color,
            Content = content,
        };
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
