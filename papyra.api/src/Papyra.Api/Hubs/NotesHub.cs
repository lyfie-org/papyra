using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Papyra.Api.Hubs;

[Authorize]
public sealed class NotesHub : Hub<INotesClient>
{
    // Client calls JoinNote when it opens a note for editing.
    public Task JoinNote(string noteId) =>
        Groups.AddToGroupAsync(Context.ConnectionId, NoteGroup(noteId));

    // Client calls LeaveNote when it closes the note editor.
    public Task LeaveNote(string noteId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, NoteGroup(noteId));

    // Client sends a content delta (stringified Lexical state or plain markdown patch).
    // Relayed to all OTHER connections in the same note group.
    public async Task SendContentDelta(string noteId, string delta)
    {
        var senderId = Context.UserIdentifier ?? Context.ConnectionId;
        await Clients
            .OthersInGroup(NoteGroup(noteId))
            .ReceiveContentDelta(noteId, delta, senderId);
    }

    private static string NoteGroup(string noteId) => $"note_{noteId}";
}
