using System.Text;

namespace Papyra.Api.Storage;

// A note cited as grounding for an answer.
public sealed record Citation(string NoteId, string Title, string Snippet, double Score);

// Retrieval-augmented chat over the vault. A question is embedded, the most similar
// note chunks are retrieved (18.1), and those chunks — plus a system prompt that
// forbids inventing anything beyond them — are sent to the configured LLM. The
// answer streams back token by token, preceded by the citations it was grounded in.
//
// Retrieval is always local (SQLite + cosine). Generation is local too by default;
// an admin may point the instance at OpenAI or Anthropic instead, in which case the
// retrieved chunks do leave the machine — which is why that choice is admin-only
// and stated plainly in the settings panel.
//
// `secure: true` notes are never embedded, so they can never be retrieved into an
// answer — the 17.2 unlock gate isn't bypassable through chat, on any provider.
public sealed class RagChatService
{
    private const int TopK = 5;

    private readonly EmbeddingService _embeddings;
    private readonly VaultState _state;
    private readonly AiClient _ai;

    public RagChatService(EmbeddingService embeddings, VaultState state, AiClient ai)
    {
        _embeddings = embeddings;
        _state = state;
        _ai = ai;
    }

    public async Task<IReadOnlyList<Citation>> RetrieveAsync(string userId, string question, CancellationToken ct)
    {
        var hits = await _embeddings.SearchAsync(userId, question, TopK, ct);
        return hits.Select(h =>
        {
            var note = _state.PathFor(userId, h.NoteId) is { } p && _state.TryGet(userId, p, out var n) ? n : null;
            return new Citation(h.NoteId, note?.Title ?? string.Empty, h.Text, h.Score);
        }).ToList();
    }

    // Compose the grounding prompt. Kept pure so the contract (cite-or-decline) is
    // unit-testable without a model.
    internal static string BuildSystemPrompt(IReadOnlyList<Citation> citations)
    {
        var sb = new StringBuilder();
        sb.AppendLine("You are Papyra's assistant. Answer using ONLY the notes below.");
        sb.AppendLine("If they do not contain the answer, say you could not find it in their notes.");
        sb.AppendLine("Never invent details. Refer to notes by their title.");
        sb.AppendLine();
        sb.AppendLine("--- NOTES ---");
        if (citations.Count == 0)
        {
            sb.AppendLine("(no relevant notes found)");
        }
        else
        {
            foreach (var c in citations)
            {
                sb.AppendLine($"# {(string.IsNullOrWhiteSpace(c.Title) ? "Untitled" : c.Title)}");
                sb.AppendLine(c.Snippet);
                sb.AppendLine();
            }
        }
        sb.AppendLine("--- END NOTES ---");
        return sb.ToString();
    }

    // Stream the model's answer as it's generated. Yields text fragments; an empty
    // sequence means the model was unreachable (the caller reports it).
    public IAsyncEnumerable<string> StreamAnswerAsync(
        string question, IReadOnlyList<Citation> citations, CancellationToken ct) =>
        _ai.StreamChatAsync(BuildSystemPrompt(citations), question, ct);
}
