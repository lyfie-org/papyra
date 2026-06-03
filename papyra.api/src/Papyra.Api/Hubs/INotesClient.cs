using Papyra.Api.Models;

namespace Papyra.Api.Hubs;

public interface INotesClient
{
    Task NoteCreated(NoteMetadata note);
    Task NoteUpdated(NoteMetadata note);
    Task NoteDeleted(string id);
    // Broadcasts a thin content delta (or full snapshot) to collaborators in the same note group.
    Task ReceiveContentDelta(string noteId, string delta, string senderId);
}
