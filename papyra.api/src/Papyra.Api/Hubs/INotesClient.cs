using Papyra.Api.Models;

namespace Papyra.Api.Hubs;

public interface INotesClient
{
    Task NoteCreated(Note note);
    Task NoteUpdated(Note note);
    Task NoteDeleted(string id);
}
