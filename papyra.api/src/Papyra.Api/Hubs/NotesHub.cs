using Microsoft.AspNetCore.SignalR;

namespace Papyra.Api.Hubs;

public sealed class NotesHub : Hub<INotesClient> { }
