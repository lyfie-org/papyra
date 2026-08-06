using System.Text;

namespace Papyra.Api.Storage;

// Splits a note body into embedding-sized chunks. Paragraph-aware: paragraphs are
// packed together up to a character budget, and an oversized paragraph is split on
// sentence-ish boundaries rather than mid-word. Pure + unit-testable.
public static class TextChunker
{
    public const int MaxChars = 1200;

    public static List<string> Chunk(string? body, int maxChars = MaxChars)
    {
        var chunks = new List<string>();
        if (string.IsNullOrWhiteSpace(body)) return chunks;

        var current = new StringBuilder();
        foreach (var paragraph in body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var text = paragraph.Trim();
            if (text.Length == 0) continue;

            // A paragraph that can't fit anywhere: flush, then split it on its own.
            if (text.Length > maxChars)
            {
                Flush(chunks, current);
                foreach (var piece in SplitLong(text, maxChars)) chunks.Add(piece);
                continue;
            }

            // +2 for the blank line we'd re-insert between paragraphs.
            if (current.Length > 0 && current.Length + text.Length + 2 > maxChars)
                Flush(chunks, current);

            if (current.Length > 0) current.Append("\n\n");
            current.Append(text);
        }

        Flush(chunks, current);
        return chunks;
    }

    private static void Flush(List<string> chunks, StringBuilder buffer)
    {
        if (buffer.Length == 0) return;
        chunks.Add(buffer.ToString().Trim());
        buffer.Clear();
    }

    // Break an over-long paragraph after sentence terminators, falling back to a hard
    // cut only when a single "sentence" is itself longer than the budget.
    private static IEnumerable<string> SplitLong(string text, int maxChars)
    {
        var buffer = new StringBuilder();
        foreach (var sentence in SplitSentences(text))
        {
            if (sentence.Length > maxChars)
            {
                if (buffer.Length > 0) { yield return buffer.ToString().Trim(); buffer.Clear(); }
                for (var i = 0; i < sentence.Length; i += maxChars)
                    yield return sentence.Substring(i, Math.Min(maxChars, sentence.Length - i)).Trim();
                continue;
            }

            if (buffer.Length > 0 && buffer.Length + sentence.Length > maxChars)
            {
                yield return buffer.ToString().Trim();
                buffer.Clear();
            }
            buffer.Append(sentence);
        }
        if (buffer.Length > 0) yield return buffer.ToString().Trim();
    }

    private static IEnumerable<string> SplitSentences(string text)
    {
        var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] is not ('.' or '!' or '?' or '\n')) continue;
            // Consume any run of terminators/whitespace so the break lands cleanly.
            var end = i + 1;
            while (end < text.Length && (char.IsWhiteSpace(text[end]) || text[end] is '.' or '!' or '?')) end++;
            yield return text[start..end];
            start = end;
            i = end - 1;
        }
        if (start < text.Length) yield return text[start..];
    }
}
