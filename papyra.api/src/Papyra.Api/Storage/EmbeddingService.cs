using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// A semantic hit: the note, the chunk that matched, and its cosine similarity.
public sealed record SemanticHit(string NoteId, string Text, double Score);

// Local semantic index. On save, a note's body is chunked and embedded via a local
// Ollama model; the vectors live in SQLite alongside the note id + owning user.
// Similarity search is brute-force cosine in-process — for a personal vault that's
// milliseconds, and it keeps Papyra a single self-contained container (no vector-DB
// service to run).
//
// Vectors are a DERIVED cache: the .md files remain the source of truth, so the
// table can be dropped and rebuilt at will. Embedding happens on a background queue
// so a save never waits on the model, and degrades to a clean no-op when Ollama or
// the model isn't there.
public sealed class EmbeddingService : BackgroundService
{
    private readonly Channel<(string UserId, string NoteId, string Body)> _queue =
        Channel.CreateUnbounded<(string, string, string)>();

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _config;
    private readonly VaultState _state;
    private readonly ILogger<EmbeddingService> _logger;
    private readonly HttpClient _http;
    private readonly string _model;

    public EmbeddingService(
        IServiceScopeFactory scopes, IConfiguration config, VaultState state, ILogger<EmbeddingService> logger)
    {
        _scopes = scopes;
        _config = config;
        _state = state;
        _logger = logger;
        _model = config["Ollama:EmbedModel"] ?? "nomic-embed-text";
        var baseUrl = config["Ollama:BaseUrl"] ?? "http://localhost:11434";
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(60) };
    }

    public bool Enabled => !string.IsNullOrWhiteSpace(_config["Ollama:BaseUrl"] ?? "http://localhost:11434");

    // Queue a note for (re-)embedding. Called from the note write path.
    public void Enqueue(string userId, string noteId, string? body) =>
        _queue.Writer.TryWrite((userId, noteId, body ?? string.Empty));

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(ct))
        {
            try { await EmbedNoteAsync(job.UserId, job.NoteId, job.Body, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Embedding failed for note {NoteId}", job.NoteId); }
        }
    }

    // Replace a note's vectors with freshly embedded chunks.
    internal async Task<int> EmbedNoteAsync(string userId, string noteId, string body, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // A re-save re-embeds from scratch — no stale chunks left behind.
        await db.NoteEmbeddings.Where(e => e.NoteId == noteId && e.UserId == userId).ExecuteDeleteAsync(ct);

        var chunks = TextChunker.Chunk(body);
        if (chunks.Count == 0) return 0;

        var index = 0;
        foreach (var chunk in chunks)
        {
            var vector = await EmbedAsync(chunk, ct);
            if (vector is null) return 0; // model unavailable — leave the note unindexed
            db.NoteEmbeddings.Add(new NoteEmbedding
            {
                NoteId = noteId,
                UserId = userId,
                ChunkIndex = index++,
                Text = chunk,
                Vector = ToBytes(vector),
                CreatedUtc = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync(ct);
        return index;
    }

    // Top-N most semantically similar chunks for a query, fenced to one tenant.
    // Vectors outlive their note (a trashed note keeps its rows until purged, and an
    // externally deleted file leaves them orphaned), so every hit is re-checked
    // against the live vault. Filtering HERE rather than at the endpoint means RAG
    // chat gets the same guarantee — a trashed note can't be cited in an answer.
    public async Task<IReadOnlyList<SemanticHit>> SearchAsync(
        string userId, string query, int take, CancellationToken ct)
    {
        var queryVector = await EmbedAsync(query, ct);
        if (queryVector is null) return [];

        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var rows = await db.NoteEmbeddings.Where(e => e.UserId == userId).ToListAsync(ct);

        return rows
            .Where(r => IsRetrievable(userId, r.NoteId))
            .Select(r => new SemanticHit(r.NoteId, r.Text, Cosine(queryVector, ToFloats(r.Vector))))
            .Where(h => h.Score > 0)
            .GroupBy(h => h.NoteId)                       // best chunk represents its note
            .Select(g => g.OrderByDescending(h => h.Score).First())
            .OrderByDescending(h => h.Score)
            .Take(take)
            .ToList();
    }

    // A note may only be retrieved while it's live in the vault: present, not
    // trashed, and not secure. (Secure notes are never embedded in the first place;
    // checked anyway so a stale row from before the flag was set can't leak.)
    internal bool IsRetrievable(string userId, string noteId)
    {
        var path = _state.PathFor(userId, noteId);
        if (path is null) return false;                        // deleted or never loaded
        if (!_state.TryGet(userId, path, out var note) || note is null) return false;
        return !note.Trashed && !note.Secure;
    }

    // Drop a note's vectors outright — used when it's trashed or deleted, so the
    // table doesn't accumulate rows the search filter would only skip over.
    public async Task RemoveNoteAsync(string userId, string noteId, CancellationToken ct = default)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await db.NoteEmbeddings
                .Where(e => e.NoteId == noteId && e.UserId == userId)
                .ExecuteDeleteAsync(ct);
        }
        catch (Exception ex)
        {
            // Vectors are a disposable cache; failing to prune must never break the
            // note operation that triggered it (the search filter still hides them).
            _logger.LogWarning(ex, "Could not remove embeddings for note {NoteId}", noteId);
        }
    }

    // Ask Ollama for one embedding. Returns null (rather than throwing) when Ollama
    // isn't running or the model is missing, so the app degrades to keyword search.
    private async Task<float[]?> EmbedAsync(string text, CancellationToken ct)
    {
        try
        {
            var res = await _http.PostAsJsonAsync("/api/embeddings",
                new { model = _model, prompt = text }, ct);
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogDebug("Ollama embeddings returned {Status}", (int)res.StatusCode);
                return null;
            }
            var payload = await res.Content.ReadFromJsonAsync<OllamaEmbedResponse>(ct);
            return payload?.Embedding is { Length: > 0 } v ? v : null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Ollama unreachable; semantic features disabled");
            return null;
        }
    }

    // ── pure helpers (unit-tested) ─────────────────────────────────────────────

    internal static double Cosine(float[] a, float[] b)
    {
        if (a.Length == 0 || a.Length != b.Length) return 0;
        double dot = 0, magA = 0, magB = 0;
        for (var i = 0; i < a.Length; i++)
        {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }
        if (magA == 0 || magB == 0) return 0;
        return dot / (Math.Sqrt(magA) * Math.Sqrt(magB));
    }

    internal static byte[] ToBytes(float[] vector)
    {
        var bytes = new byte[vector.Length * sizeof(float)];
        Buffer.BlockCopy(vector, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    internal static float[] ToFloats(byte[] bytes)
    {
        var floats = new float[bytes.Length / sizeof(float)];
        Buffer.BlockCopy(bytes, 0, floats, 0, bytes.Length);
        return floats;
    }

    private sealed class OllamaEmbedResponse
    {
        [JsonPropertyName("embedding")]
        public float[]? Embedding { get; set; }
    }
}
