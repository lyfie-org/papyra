using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Papyra.Api.Storage;

/// <summary>Setting keys for the AI provider. See <see cref="InstanceConfigStore"/>.</summary>
public static class AiKeys
{
    /// <summary>Which backend answers chat: <c>ollama</c>, <c>openai</c> or <c>anthropic</c>.</summary>
    public const string ChatProvider = "ai.chatProvider";
    /// <summary>Which backend produces embeddings: <c>ollama</c> or <c>openai</c>.</summary>
    public const string EmbedProvider = "ai.embedProvider";

    public const string OllamaBaseUrl = "ai.ollama.baseUrl";
    public const string OllamaChatModel = "ai.ollama.chatModel";
    public const string OllamaEmbedModel = "ai.ollama.embedModel";

    public const string OpenAiKey = "ai.openai.apiKey";
    public const string OpenAiChatModel = "ai.openai.chatModel";
    public const string OpenAiEmbedModel = "ai.openai.embedModel";
    public const string OpenAiBaseUrl = "ai.openai.baseUrl";

    public const string AnthropicKey = "ai.anthropic.apiKey";
    public const string AnthropicChatModel = "ai.anthropic.chatModel";
}

public enum AiProviderKind { Ollama, OpenAi, Anthropic }

/// <summary>
/// A resolved snapshot of the AI configuration. Built from the database, falling
/// back to appsettings so an instance configured the old `Ollama:*` way keeps
/// working untouched.
/// </summary>
public sealed record AiSettings(
    AiProviderKind ChatProvider,
    AiProviderKind EmbedProvider,
    string OllamaBaseUrl,
    string OllamaChatModel,
    string OllamaEmbedModel,
    string OpenAiBaseUrl,
    string OpenAiChatModel,
    string OpenAiEmbedModel,
    string AnthropicChatModel,
    string? OpenAiKey,
    string? AnthropicKey)
{
    /// <summary>True when the chat backend has everything it needs to answer.</summary>
    public bool ChatConfigured => ChatProvider switch
    {
        AiProviderKind.OpenAi => !string.IsNullOrWhiteSpace(OpenAiKey),
        AiProviderKind.Anthropic => !string.IsNullOrWhiteSpace(AnthropicKey),
        _ => !string.IsNullOrWhiteSpace(OllamaBaseUrl),
    };

    /// <summary>True when the embedding backend has everything it needs.</summary>
    public bool EmbedConfigured => EmbedProvider switch
    {
        AiProviderKind.OpenAi => !string.IsNullOrWhiteSpace(OpenAiKey),
        _ => !string.IsNullOrWhiteSpace(OllamaBaseUrl),
    };

    public string ChatModel => ChatProvider switch
    {
        AiProviderKind.OpenAi => OpenAiChatModel,
        AiProviderKind.Anthropic => AnthropicChatModel,
        _ => OllamaChatModel,
    };

    public string EmbedModel => EmbedProvider == AiProviderKind.OpenAi ? OpenAiEmbedModel : OllamaEmbedModel;
}

/// <summary>What the AI button should tell the user, and whether it can work at all.</summary>
/// <param name="Ready">The chat backend is configured and reachable.</param>
/// <param name="Reason">Plain-English explanation when <paramref name="Ready"/> is false.</param>
/// <param name="CanPull">Ollama is running, so a model download can be offered.</param>
/// <param name="InstalledModels">Model tags Ollama already has locally.</param>
public sealed record AiStatus(
    string ChatProvider,
    string EmbedProvider,
    string ChatModel,
    string EmbedModel,
    bool Ready,
    string? Reason,
    bool CanPull,
    IReadOnlyList<string> InstalledModels,
    bool SemanticSearchReady);

/// <summary>
/// One earlier turn of a conversation, as the model sees it: who said it and
/// what they said. Deliberately not the stored entity — the model has no use for
/// ids, timestamps or citations.
/// </summary>
public sealed record ChatTurn(string Role, string Content);

/// <summary>One frame of an Ollama model download.</summary>
public sealed record PullProgress(string Status, long Completed, long Total, string? Error);

/// <summary>
/// The single door to every AI backend. Chat and embeddings are resolved
/// independently because the providers differ in what they offer: Anthropic has
/// no embeddings endpoint, so an Anthropic chat instance still needs Ollama or
/// OpenAI to power semantic search.
///
/// Everything here degrades rather than throws — an unreachable model must never
/// break a note save or take the app down, so callers get null/empty and the UI
/// explains why (that explanation is the whole point of <see cref="ProbeAsync"/>).
///
/// Settings are cached against <see cref="InstanceConfigStore.Version"/>, so an
/// admin saving the AI panel applies immediately with no restart — the same
/// contract the SSO panel has.
/// </summary>
public sealed class AiClient
{
    // The three models a user may install, spanning a Raspberry Pi to a
    // workstation. Deliberately three and no more: this is a one-time choice made
    // by someone who has no interest in researching language models, so each is
    // described as size / memory / what it's good at, with no jargon and no
    // fourth option to agonise over.
    public static readonly IReadOnlyList<AiModelChoice> ChatModelChoices =
    [
        // Measured, not guessed: this one reliably finds the right note but often
        // won't answer from it, so the card says so rather than overselling.
        new("llama3.2:1b", "Small", "1.3 GB", "2 GB",
            "Runs on almost anything, including a Raspberry Pi. Good at finding the right note; often can’t answer detailed questions about it."),
        new("llama3.1:8b", "Balanced", "4.7 GB", "8 GB",
            "The one most people want. Comfortable on any recent laptop or desktop."),
        new("mistral-nemo:12b", "Best", "7.1 GB", "12 GB",
            "The most accurate answers, and the slowest. Wants a powerful machine or a graphics card."),
    ];

    /// <summary>Embeddings model pulled alongside a chat model so semantic search works.</summary>
    public const string DefaultEmbedModel = "nomic-embed-text";

    private readonly InstanceConfigStore _config;
    private readonly IConfiguration _appConfig;
    private readonly ILogger<AiClient> _logger;
    private readonly IHttpClientFactory _http;

    private AiSettings? _cached;
    private int _cachedVersion = -1;

    public AiClient(
        InstanceConfigStore config, IConfiguration appConfig, IHttpClientFactory http, ILogger<AiClient> logger)
    {
        _config = config;
        _appConfig = appConfig;
        _http = http;
        _logger = logger;
    }

    // ── settings ──────────────────────────────────────────────────────────────

    /// <summary>
    /// The effective configuration. Re-read only when a write bumped the store's
    /// version, so the hot embedding path isn't parsing settings per note.
    /// </summary>
    public async Task<AiSettings> SettingsAsync(CancellationToken ct = default)
    {
        await _config.EnsureLoadedAsync(ct);
        if (_cached is { } hit && _cachedVersion == _config.Version) return hit;

        var settings = Resolve();
        _cached = settings;
        _cachedVersion = _config.Version;
        return settings;
    }

    private AiSettings Resolve()
    {
        // appsettings supplies the fallback so an existing deployment that only
        // ever set `Ollama:BaseUrl` behaves exactly as it did before this panel.
        string Fall(string key, string appKey, string fallback) =>
            _config.Has(key) ? _config.GetOrEmpty(key)
            : _appConfig[appKey] is { Length: > 0 } v ? v
            : fallback;

        return new AiSettings(
            ChatProvider: ParseProvider(_config.Get(AiKeys.ChatProvider), AiProviderKind.Ollama),
            // Anthropic can't embed, so it is never a valid embedding provider —
            // ParseProvider folds it back to Ollama rather than silently breaking search.
            EmbedProvider: ParseProvider(_config.Get(AiKeys.EmbedProvider), AiProviderKind.Ollama) switch
            {
                AiProviderKind.OpenAi => AiProviderKind.OpenAi,
                _ => AiProviderKind.Ollama,
            },
            OllamaBaseUrl: Fall(AiKeys.OllamaBaseUrl, "Ollama:BaseUrl", "http://localhost:11434").TrimEnd('/'),
            OllamaChatModel: Fall(AiKeys.OllamaChatModel, "Ollama:ChatModel", "mistral-nemo:12b"),
            OllamaEmbedModel: Fall(AiKeys.OllamaEmbedModel, "Ollama:EmbedModel", DefaultEmbedModel),
            OpenAiBaseUrl: Fall(AiKeys.OpenAiBaseUrl, "OpenAi:BaseUrl", "https://api.openai.com/v1").TrimEnd('/'),
            OpenAiChatModel: Fall(AiKeys.OpenAiChatModel, "OpenAi:ChatModel", "gpt-4o"),
            OpenAiEmbedModel: Fall(AiKeys.OpenAiEmbedModel, "OpenAi:EmbedModel", "text-embedding-3-small"),
            AnthropicChatModel: Fall(AiKeys.AnthropicChatModel, "Anthropic:ChatModel", "claude-opus-5"),
            OpenAiKey: _config.Get(AiKeys.OpenAiKey),
            AnthropicKey: _config.Get(AiKeys.AnthropicKey));
    }

    public static AiProviderKind ParseProvider(string? raw, AiProviderKind fallback) => raw?.Trim().ToLowerInvariant() switch
    {
        "openai" => AiProviderKind.OpenAi,
        "anthropic" => AiProviderKind.Anthropic,
        "ollama" => AiProviderKind.Ollama,
        _ => fallback,
    };

    public static string ProviderName(AiProviderKind kind) => kind switch
    {
        AiProviderKind.OpenAi => "openai",
        AiProviderKind.Anthropic => "anthropic",
        _ => "ollama",
    };

    // ── status ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Ask the configured backend whether it can actually answer, and say why not
    /// when it can't. This is what turns a silently-empty AI panel into a panel
    /// that explains itself and offers a fix.
    /// </summary>
    public async Task<AiStatus> ProbeAsync(CancellationToken ct = default)
    {
        var s = await SettingsAsync(ct);
        var installed = Array.Empty<string>() as IReadOnlyList<string>;
        var ollamaUp = false;

        // Always probe Ollama: even on a cloud chat provider its presence decides
        // whether semantic search works and whether a pull can be offered.
        if (!string.IsNullOrWhiteSpace(s.OllamaBaseUrl))
        {
            var tags = await OllamaTagsAsync(s, ct);
            ollamaUp = tags is not null;
            installed = tags ?? installed;
        }

        var (ready, reason) = s.ChatProvider switch
        {
            AiProviderKind.OpenAi when string.IsNullOrWhiteSpace(s.OpenAiKey) =>
                (false, "No OpenAI API key is configured. An admin can add one in Settings → AI."),
            AiProviderKind.Anthropic when string.IsNullOrWhiteSpace(s.AnthropicKey) =>
                (false, "No Anthropic API key is configured. An admin can add one in Settings → AI."),
            // Deliberately no model identifiers or URLs in these sentences — they
            // are read by someone deciding what to click, not debugging a service.
            AiProviderKind.Ollama when !ollamaUp =>
                (false, "The assistant isn’t set up yet — the part that runs models on this machine isn’t responding."),
            AiProviderKind.Ollama when !HasModel(installed, s.OllamaChatModel) =>
                (false, "No model is installed yet. Choose one below to switch the assistant on."),
            _ => (true, (string?)null),
        };

        var semanticReady = s.EmbedProvider switch
        {
            AiProviderKind.OpenAi => !string.IsNullOrWhiteSpace(s.OpenAiKey),
            _ => ollamaUp && HasModel(installed, s.OllamaEmbedModel),
        };

        return new AiStatus(
            ProviderName(s.ChatProvider), ProviderName(s.EmbedProvider),
            s.ChatModel, s.EmbedModel,
            ready, reason,
            CanPull: ollamaUp,
            InstalledModels: installed,
            SemanticSearchReady: semanticReady);
    }

    // Ollama reports "llama3.1:8b"; a bare "llama3.1" means the :latest tag.
    internal static bool HasModel(IReadOnlyList<string> installed, string wanted)
    {
        if (string.IsNullOrWhiteSpace(wanted)) return false;
        var target = wanted.Contains(':') ? wanted : wanted + ":latest";
        return installed.Any(m => string.Equals(m, target, StringComparison.OrdinalIgnoreCase)
                               || string.Equals(m, wanted, StringComparison.OrdinalIgnoreCase));
    }

    private async Task<IReadOnlyList<string>?> OllamaTagsAsync(AiSettings s, CancellationToken ct)
    {
        try
        {
            using var http = _http.CreateClient("ai-probe");
            using var res = await http.GetAsync($"{s.OllamaBaseUrl}/api/tags", ct);
            if (!res.IsSuccessStatusCode) return null;
            var payload = await res.Content.ReadFromJsonAsync<OllamaTags>(ct);
            return payload?.Models?.Select(m => m.Name ?? string.Empty).Where(n => n.Length > 0).ToList() ?? [];
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Ollama not reachable while probing AI status");
            return null;
        }
    }

    // ── embeddings ────────────────────────────────────────────────────────────

    /// <summary>
    /// One embedding vector, or null when the backend is unreachable or
    /// misconfigured — the caller then leaves the note unindexed and keyword
    /// search carries on.
    /// </summary>
    public async Task<float[]?> EmbedAsync(string text, CancellationToken ct)
    {
        var s = await SettingsAsync(ct);
        if (!s.EmbedConfigured) return null;

        try
        {
            return s.EmbedProvider == AiProviderKind.OpenAi
                ? await OpenAiEmbedAsync(s, text, ct)
                : await OllamaEmbedAsync(s, text, ct);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Embedding backend unavailable; semantic features disabled");
            return null;
        }
    }

    private async Task<float[]?> OllamaEmbedAsync(AiSettings s, string text, CancellationToken ct)
    {
        using var http = _http.CreateClient("ai-embed");
        using var res = await http.PostAsJsonAsync(
            $"{s.OllamaBaseUrl}/api/embeddings", new { model = s.OllamaEmbedModel, prompt = text }, ct);
        if (!res.IsSuccessStatusCode)
        {
            _logger.LogDebug("Ollama embeddings returned {Status}", (int)res.StatusCode);
            return null;
        }
        var payload = await res.Content.ReadFromJsonAsync<OllamaEmbedResponse>(ct);
        return payload?.Embedding is { Length: > 0 } v ? v : null;
    }

    private async Task<float[]?> OpenAiEmbedAsync(AiSettings s, string text, CancellationToken ct)
    {
        using var http = _http.CreateClient("ai-embed");
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{s.OpenAiBaseUrl}/embeddings")
        {
            Content = JsonContent.Create(new { model = s.OpenAiEmbedModel, input = text }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", s.OpenAiKey);
        using var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            _logger.LogWarning("OpenAI embeddings returned {Status}", (int)res.StatusCode);
            return null;
        }
        var payload = await res.Content.ReadFromJsonAsync<OpenAiEmbedResponse>(ct);
        return payload?.Data?.FirstOrDefault()?.Embedding is { Length: > 0 } v ? v : null;
    }

    // ── chat ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Stream an answer fragment by fragment. An empty sequence means the backend
    /// couldn't be reached; the caller reports that to the user rather than
    /// showing an empty answer.
    /// </summary>
    public IAsyncEnumerable<string> StreamChatAsync(
        string system, string question, CancellationToken ct) =>
        StreamChatAsync(system, question, [], ct);

    /// <param name="history">
    /// Earlier turns of the same conversation, oldest first. Every provider takes
    /// the same shape — a list of role/content pairs — so this is threaded through
    /// as one list rather than three provider-specific ideas of a transcript.
    /// </param>
    public async IAsyncEnumerable<string> StreamChatAsync(
        string system, string question, IReadOnlyList<ChatTurn> history,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var s = await SettingsAsync(ct);
        if (!s.ChatConfigured) yield break;

        var stream = s.ChatProvider switch
        {
            AiProviderKind.OpenAi => OpenAiChatAsync(s, system, question, history, ct),
            AiProviderKind.Anthropic => AnthropicChatAsync(s, system, question, history, ct),
            _ => OllamaChatAsync(s, system, question, history, ct),
        };

        await foreach (var chunk in stream.WithCancellation(ct)) yield return chunk;
    }

    // The transcript in the shape all three providers accept: role + content,
    // oldest first, with the new question last.
    private static object[] Turns(string question, IReadOnlyList<ChatTurn> history) =>
    [
        .. history.Select(h => new { role = h.Role == "assistant" ? "assistant" : "user", content = h.Content }),
        new { role = "user", content = question },
    ];

    private async IAsyncEnumerable<string> OllamaChatAsync(
        AiSettings s, string system, string question, IReadOnlyList<ChatTurn> history,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var body = new
        {
            model = s.OllamaChatModel,
            stream = true,
            messages = new object[] { new { role = "system", content = system } }
                .Concat(Turns(question, history)).ToArray(),
        };

        using var http = _http.CreateClient("ai-chat");
        HttpResponseMessage? res = null;
        try { res = await PostStreamAsync(http, $"{s.OllamaBaseUrl}/api/chat", body, null, ct); }
        catch (Exception ex) { _logger.LogWarning(ex, "Ollama chat unreachable"); }
        if (res is null) yield break;

        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogWarning("Ollama chat returned {Status}", (int)res.StatusCode);
                yield break;
            }

            // Ollama streams newline-delimited JSON, one object per token batch.
            await foreach (var line in ReadLinesAsync(res, ct))
            {
                OllamaChatChunk? chunk = null;
                try { chunk = JsonSerializer.Deserialize<OllamaChatChunk>(line); }
                catch (JsonException) { /* skip a malformed frame rather than abort */ }

                if (chunk?.Message?.Content is { Length: > 0 } text) yield return text;
                if (chunk?.Done == true) yield break;
            }
        }
    }

    private async IAsyncEnumerable<string> OpenAiChatAsync(
        AiSettings s, string system, string question, IReadOnlyList<ChatTurn> history,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var body = new
        {
            model = s.OpenAiChatModel,
            stream = true,
            messages = new object[] { new { role = "system", content = system } }
                .Concat(Turns(question, history)).ToArray(),
        };

        using var http = _http.CreateClient("ai-chat");
        HttpResponseMessage? res = null;
        try
        {
            res = await PostStreamAsync(http, $"{s.OpenAiBaseUrl}/chat/completions", body,
                r => r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", s.OpenAiKey), ct);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "OpenAI chat unreachable"); }
        if (res is null) yield break;

        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogWarning("OpenAI chat returned {Status}", (int)res.StatusCode);
                yield break;
            }

            await foreach (var data in ReadSseDataAsync(res, ct))
            {
                if (data == "[DONE]") yield break;
                OpenAiChatChunk? chunk = null;
                try { chunk = JsonSerializer.Deserialize<OpenAiChatChunk>(data); }
                catch (JsonException) { /* skip a malformed frame */ }

                if (chunk?.Choices?.FirstOrDefault()?.Delta?.Content is { Length: > 0 } text)
                    yield return text;
            }
        }
    }

    private async IAsyncEnumerable<string> AnthropicChatAsync(
        AiSettings s, string system, string question, IReadOnlyList<ChatTurn> history,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // Grounded Q&A over a handful of note chunks: `low` effort keeps the
        // time-to-first-token short. Thinking is deliberately left on (the default
        // on current models) — disabling it is what makes them leak <thinking>
        // tags into the visible answer.
        var body = new
        {
            model = s.AnthropicChatModel,
            max_tokens = 4096,
            stream = true,
            output_config = new { effort = "low" },
            // Safety classifiers can decline a request outright. Letting the API
            // re-run it on its recommended fallback means an odd note phrasing
            // doesn't dead-end as a blank answer.
            fallbacks = "default",
            system,
            messages = Turns(question, history),
        };

        using var http = _http.CreateClient("ai-chat");
        HttpResponseMessage? res = null;
        try
        {
            res = await PostStreamAsync(http, "https://api.anthropic.com/v1/messages", body, r =>
            {
                r.Headers.Add("x-api-key", s.AnthropicKey);
                r.Headers.Add("anthropic-version", "2023-06-01");
                r.Headers.Add("anthropic-beta", "server-side-fallback-2026-07-01");
            }, ct);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Anthropic chat unreachable"); }
        if (res is null) yield break;

        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogWarning("Anthropic chat returned {Status}", (int)res.StatusCode);
                yield break;
            }

            await foreach (var data in ReadSseDataAsync(res, ct))
            {
                AnthropicEvent? evt = null;
                try { evt = JsonSerializer.Deserialize<AnthropicEvent>(data); }
                catch (JsonException) { /* skip a malformed frame */ }
                if (evt is null) continue;

                switch (evt.Type)
                {
                    case "content_block_delta" when evt.Delta?.Text is { Length: > 0 } text:
                        yield return text;
                        break;
                    // A refusal is a successful HTTP 200 with no usable content —
                    // say so plainly instead of returning an empty answer.
                    case "message_delta" when evt.Delta?.StopReason == "refusal":
                        yield return "\n\n(The model declined to answer this one.)";
                        yield break;
                    case "message_stop":
                        yield break;
                }
            }
        }
    }

    // ── model download ────────────────────────────────────────────────────────

    /// <summary>
    /// Pull a model into Ollama, surfacing byte-level progress so the UI can show
    /// a real bar rather than an indeterminate spinner on a multi-gigabyte wait.
    /// </summary>
    public async IAsyncEnumerable<PullProgress> PullModelAsync(
        string model, [EnumeratorCancellation] CancellationToken ct)
    {
        var s = await SettingsAsync(ct);

        using var http = _http.CreateClient("ai-pull");
        HttpResponseMessage? res = null;
        string? failure = null;
        try
        {
            res = await PostStreamAsync(http, $"{s.OllamaBaseUrl}/api/pull",
                new { model, stream = true }, null, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not start model pull for {Model}", model);
            failure = "Could not reach Ollama to start the download.";
        }

        if (failure is not null || res is null)
        {
            yield return new PullProgress("error", 0, 0, failure ?? "Could not reach Ollama.");
            yield break;
        }

        using (res)
        {
            if (!res.IsSuccessStatusCode)
            {
                yield return new PullProgress("error", 0, 0, $"Ollama refused the download ({(int)res.StatusCode}).");
                yield break;
            }

            await foreach (var line in ReadLinesAsync(res, ct))
            {
                OllamaPullFrame? frame = null;
                try { frame = JsonSerializer.Deserialize<OllamaPullFrame>(line); }
                catch (JsonException) { continue; }
                if (frame is null) continue;

                if (frame.Error is { Length: > 0 } err)
                {
                    yield return new PullProgress("error", 0, 0, err);
                    yield break;
                }
                yield return new PullProgress(frame.Status ?? "downloading", frame.Completed, frame.Total, null);
            }
        }
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    // Send a streaming POST: the response headers must come back before the body
    // is read, or the whole answer buffers and nothing streams.
    private static async Task<HttpResponseMessage> PostStreamAsync(
        HttpClient http, string url, object body, Action<HttpRequestMessage>? decorate, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(body) };
        decorate?.Invoke(req);
        return await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private static async IAsyncEnumerable<string> ReadLinesAsync(
        HttpResponseMessage res, [EnumeratorCancellation] CancellationToken ct)
    {
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!string.IsNullOrWhiteSpace(line)) yield return line;
        }
    }

    // Both OpenAI and Anthropic stream Server-Sent Events; only the `data:` lines
    // carry payload, and the `event:` lines duplicate what's inside the JSON.
    private static async IAsyncEnumerable<string> ReadSseDataAsync(
        HttpResponseMessage res, [EnumeratorCancellation] CancellationToken ct)
    {
        await foreach (var line in ReadLinesAsync(res, ct))
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = line[5..].Trim();
            if (data.Length > 0) yield return data;
        }
    }

    // ── wire shapes ───────────────────────────────────────────────────────────

    private sealed class OllamaTags
    {
        [JsonPropertyName("models")] public List<OllamaTag>? Models { get; set; }
    }

    private sealed class OllamaTag
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
    }

    private sealed class OllamaEmbedResponse
    {
        [JsonPropertyName("embedding")] public float[]? Embedding { get; set; }
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

    private sealed class OllamaPullFrame
    {
        [JsonPropertyName("status")] public string? Status { get; set; }
        [JsonPropertyName("completed")] public long Completed { get; set; }
        [JsonPropertyName("total")] public long Total { get; set; }
        [JsonPropertyName("error")] public string? Error { get; set; }
    }

    private sealed class OpenAiEmbedResponse
    {
        [JsonPropertyName("data")] public List<OpenAiEmbedItem>? Data { get; set; }
    }

    private sealed class OpenAiEmbedItem
    {
        [JsonPropertyName("embedding")] public float[]? Embedding { get; set; }
    }

    private sealed class OpenAiChatChunk
    {
        [JsonPropertyName("choices")] public List<OpenAiChoice>? Choices { get; set; }
    }

    private sealed class OpenAiChoice
    {
        [JsonPropertyName("delta")] public OpenAiDelta? Delta { get; set; }
    }

    private sealed class OpenAiDelta
    {
        [JsonPropertyName("content")] public string? Content { get; set; }
    }

    private sealed class AnthropicEvent
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("delta")] public AnthropicDelta? Delta { get; set; }
    }

    private sealed class AnthropicDelta
    {
        [JsonPropertyName("text")] public string? Text { get; set; }
        [JsonPropertyName("stop_reason")] public string? StopReason { get; set; }
    }
}

/// <summary>
/// A model the user can install, described the way a shopper would want it:
/// what it's called in plain words, what it costs in disk and memory, and what
/// it's good at. <paramref name="Model"/> is the only technical value, and the
/// UI never shows it.
/// </summary>
public sealed record AiModelChoice(string Model, string Tier, string Size, string Memory, string Blurb);
