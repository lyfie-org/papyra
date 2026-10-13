using System.Net.Http.Json;

namespace Papyra.Api.Collab;

public enum CollabStatus
{
    /// <summary>Turned off (<c>PAPYRA_COLLAB_ENABLED=false</c>).</summary>
    Disabled,
    /// <summary>Engine launching or not answered yet.</summary>
    Starting,
    /// <summary>Engine up; live editing available.</summary>
    Ok,
    /// <summary>Engine down / crash-looping / Node missing. Notes fall back to classic autosave.</summary>
    Degraded,
}

/// <summary>
/// The API's handle on the embedded collab engine: where it listens, whether it
/// is healthy, and the room controls the API needs (kick a revoked user, close
/// a trashed note, push an external file edit). Every call is best-effort and
/// never throws — with the engine down there are no live rooms to steer.
/// </summary>
public interface ICollabEngine
{
    CollabStatus Status { get; }
    /// <summary>Loopback base URL of the engine, when known.</summary>
    Uri? BaseUrl { get; }
    string Secret { get; }
    TimeSpan TicketLifetime { get; }

    /// <summary>Whether a live room exists for this note right now.</summary>
    Task<bool> IsRoomActiveAsync(string ownerUid, string noteId, CancellationToken ct = default);
    Task KickAsync(string ownerUid, string noteId, int uid, CancellationToken ct = default);
    /// <summary>Close a room: <c>flush</c> saves pending edits first, <c>discard</c> drops them.</summary>
    Task CloseAsync(string ownerUid, string noteId, bool flush, CancellationToken ct = default);
    /// <summary>The file changed outside the API (watcher): merge it into any live room.</summary>
    Task ExternalChangeAsync(string ownerUid, string noteId, string body, CancellationToken ct = default);
    /// <summary>Save whatever a live room has pending, keeping the room open.</summary>
    Task FlushAsync(string ownerUid, string noteId, CancellationToken ct = default);
    /// <summary>An older version was restored: it replaces the live room's text (never merged).</summary>
    Task RestoreAsync(string ownerUid, string noteId, string body, CancellationToken ct = default);
    /// <summary>
    /// Merge an agent's whole-body edit, made against the file version hashed
    /// <paramref name="baseHash"/>, into the live room and save it. Null when
    /// the engine could not be reached.
    /// </summary>
    Task<AgentEditOutcome?> AgentEditAsync(string ownerUid, string noteId, string baseHash, string body,
        CollabAgent agent, CancellationToken ct = default);
}

/// <summary>
/// Someone editing a live note from outside its room — a script or AI agent on
/// an API key. <paramref name="Contributor"/> is who history credits: a user id,
/// or minus the API key's id (see <see cref="LiveAgentEdits"/>); <paramref name="Name"/>
/// is what the room's presence shows.
/// </summary>
public sealed record CollabAgent(int Contributor, int Uid, string Username, string Name);

/// <summary>
/// What the room did with an agent edit. <c>applied</c>: merged and saved, the
/// file is now <see cref="Body"/>. <c>stale</c>: the agent read a version the
/// room never held — <see cref="Body"/> is the current one to redo it against.
/// <c>not-live</c>: no room (anymore). <c>gone</c>: the note was trashed or locked.
/// </summary>
public sealed record AgentEditOutcome(string Kind, string? Body, string? Hash, bool Conflicted)
{
    public const string Applied = "applied";
    public const string Stale = "stale";
    public const string NotLive = "not-live";
    public const string Gone = "gone";
}

/// <summary>HTTP client for the engine's loopback-only internal routes.</summary>
public sealed class CollabEngine(CollabOptions options, IHttpClientFactory http, ILogger<CollabEngine> logger)
    : ICollabEngine
{
    public const string HttpClientName = "collab-engine";

    private volatile CollabStatus _status = options.Enabled ? CollabStatus.Starting : CollabStatus.Disabled;
    private Uri? _baseUrl;

    public CollabStatus Status => _status;
    public Uri? BaseUrl => _baseUrl;
    public string Secret => options.Secret;
    public TimeSpan TicketLifetime => options.TicketLifetime;

    /// <summary>Set by <see cref="CollabHost"/> as the engine comes and goes.</summary>
    internal void SetState(CollabStatus status, Uri? baseUrl)
    {
        _baseUrl = baseUrl;
        _status = options.Enabled ? status : CollabStatus.Disabled;
    }

    private static string Room(string ownerUid, string noteId) =>
        Uri.EscapeDataString($"{ownerUid}:{noteId}");

    private async Task<HttpResponseMessage?> SendAsync(HttpMethod method, string path, HttpContent? content, CancellationToken ct)
    {
        if (_status != CollabStatus.Ok || _baseUrl is null) return null;
        try
        {
            using var request = new HttpRequestMessage(method, new Uri(_baseUrl, path)) { Content = content };
            request.Headers.Add("X-Collab-Secret", options.Secret);
            return await http.CreateClient(HttpClientName).SendAsync(request, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning("Collab engine call {Method} {Path} failed: {Message}", method, path, ex.Message);
            return null;
        }
    }

    public async Task<bool> IsRoomActiveAsync(string ownerUid, string noteId, CancellationToken ct = default)
    {
        using var response = await SendAsync(HttpMethod.Get, $"/rooms/{Room(ownerUid, noteId)}", null, ct);
        if (response is not { IsSuccessStatusCode: true }) return false;
        var body = await response.Content.ReadFromJsonAsync<RoomInfo>(ct);
        return body?.Active == true;
    }

    public async Task KickAsync(string ownerUid, string noteId, int uid, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"/rooms/{Room(ownerUid, noteId)}/kick?uid={uid}", null, ct);
    }

    public async Task CloseAsync(string ownerUid, string noteId, bool flush, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post,
            $"/rooms/{Room(ownerUid, noteId)}/close?mode={(flush ? "flush" : "discard")}", null, ct);
    }

    public async Task ExternalChangeAsync(string ownerUid, string noteId, string body, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"/rooms/{Room(ownerUid, noteId)}/external",
            JsonContent.Create(new { body, hash = CollabHash.Of(body) }), ct);
    }

    public async Task FlushAsync(string ownerUid, string noteId, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"/rooms/{Room(ownerUid, noteId)}/flush", null, ct);
    }

    public async Task RestoreAsync(string ownerUid, string noteId, string body, CancellationToken ct = default)
    {
        using var _ = await SendAsync(HttpMethod.Post, $"/rooms/{Room(ownerUid, noteId)}/restore",
            JsonContent.Create(new { body, hash = CollabHash.Of(body) }), ct);
    }

    public async Task<AgentEditOutcome?> AgentEditAsync(string ownerUid, string noteId, string baseHash, string body,
        CollabAgent agent, CancellationToken ct = default)
    {
        using var response = await SendAsync(HttpMethod.Post, $"/rooms/{Room(ownerUid, noteId)}/agent-edit",
            JsonContent.Create(new
            {
                baseHash,
                body,
                agent = new { contributor = agent.Contributor, uid = agent.Uid, username = agent.Username, name = agent.Name },
            }), ct);
        if (response is not { IsSuccessStatusCode: true })
        {
            if (response is not null)
                logger.LogWarning("Collab engine refused an agent edit for {NoteId}: HTTP {Status}", noteId, (int)response.StatusCode);
            return null;
        }
        return await response.Content.ReadFromJsonAsync<AgentEditOutcome>(ct);
    }

    private sealed record RoomInfo(bool Active, int Connections);
}
