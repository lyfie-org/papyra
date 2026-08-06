using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Papyra.Api.Storage;

// A note cited as grounding for an answer.
public sealed record Citation(string NoteId, string Title, string Snippet, double Score);

// Retrieval-augmented chat over the local vault. A question is embedded, the most
// similar note chunks are retrieved (18.1), and those chunks — plus a system prompt
// that forbids inventing anything beyond them — are sent to a local Ollama LLM. The
// answer streams back token by token, preceded by the citations it was grounded in.
//
// Entirely offline: retrieval is SQLite + cosine, generation is a local model.
// `secure: true` notes are never embedded, so they can never be retrieved into an
// answer — the 17.2 unlock gate isn't bypassable through chat.
public sealed class RagChatService
{
    private const int TopK = 5;

    private readonly EmbeddingService _embeddings;
    private readonly VaultState _state;
    private readonly ILogger<RagChatService> _logger;
    private readonly HttpClient _http;
    private readonly string _model;

    public RagChatService(
        EmbeddingService embeddings, VaultState state, IConfiguration config, ILogger<RagChatService> logger)
    {
        _embeddings = embeddings;
        _state = state;
        _logger = logger;
        _model = config["Ollama:ChatModel"] ?? "mistral-nemo:12b";
        var baseUrl = config["Ollama:BaseUrl"] ?? "http://localhost:11434";
        // Generation is slow relative to everything else in the app; allow for it.
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromMinutes(5) };
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
    public async IAsyncEnumerable<string> StreamAnswerAsync(
        string question, IReadOnlyList<Citation> citations,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var request = new
        {
            model = _model,
            stream = true,
            messages = new[]
            {
                new { role = "system", content = BuildSystemPrompt(citations) },
                new { role = "user", content = question },
            },
        };

        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsJsonAsync("/api/chat", request, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Ollama chat unreachable");
            yield break;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Ollama chat returned {Status}", (int)response.StatusCode);
                yield break;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream);
            // Ollama streams newline-delimited JSON, one object per token batch.
            while (await reader.ReadLineAsync(ct) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                OllamaChatChunk? chunk = null;
                try { chunk = JsonSerializer.Deserialize<OllamaChatChunk>(line); }
                catch (JsonException) { /* skip a malformed frame rather than abort */ }

                var content = chunk?.Message?.Content;
                if (!string.IsNullOrEmpty(content)) yield return content;
                if (chunk?.Done == true) yield break;
            }
        }
    }

    private sealed class OllamaChatChunk
    {
        [JsonPropertyName("message")] public OllamaMessage? Message { get; set; }
        [JsonPropertyName("done")] public bool Done { get; set; }
    }

    private sealed class OllamaMessage
    {
        [JsonPropertyName("content")] public string? Content { get; set; }
    }
}
