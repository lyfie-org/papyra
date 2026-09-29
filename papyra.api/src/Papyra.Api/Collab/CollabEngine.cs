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

    private sealed record RoomInfo(bool Active, int Connections);
}
