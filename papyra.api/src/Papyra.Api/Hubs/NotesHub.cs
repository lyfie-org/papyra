using Microsoft.AspNetCore.SignalR;
using Papyra.Api.Models;

namespace Papyra.Api.Hubs;

// Real-time bridge to clients. The observer broadcasts metadata-only events here
// after the debouncer confirms an external change; clients invalidate their grid
// and fetch the body only for the open note. No methods — push-only hub.
public sealed class NotesHub : Hub
{
}

// WebSocket payload discipline: broadcast YAML/metadata only, never the body.
public sealed record NoteMetadata(
    string Id,
    string Title,
    IReadOnlyList<string> Tags,
    string? Color,
    bool Pinned)
{
    public static NoteMetadata From(Note note) =>
        new(note.Id, note.Title, note.Tags, note.Color, note.Pinned);
}
