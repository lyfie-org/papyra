using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Services;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddSignalR();
builder.Services.AddCors(options => options.AddPolicy("ViteDev", policy =>
    policy.WithOrigins("http://localhost:5173")
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials()));
builder.Services.AddSingleton<IMarkdownStorageService, MarkdownStorageService>();
builder.Services.AddSingleton<IndexManager>();
builder.Services.AddSingleton<NoteWatcherService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<NoteWatcherService>());

var app = builder.Build();

app.UseCors("ViteDev");
app.MapOpenApi();

app.MapScalarApiReference(options => 
    {
        options.WithTitle("Papyra API")
               .WithClassicLayout()
               .HideSearch()
               .HideDeveloperTools()
               .WithDocumentDownloadType(DocumentDownloadType.None)
               .DisableAgent()
               .WithCustomCss(".scalar-app .references-header { display: none !important; }");
    });

app.MapHub<NotesHub>("/hubs/notes");

// ── Notes CRUD ────────────────────────────────────────────────────────────────

app.MapGet("/notes", (NoteWatcherService watcher) =>
    Results.Ok(watcher.Notes.Values.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color,
    })))
    .WithName("GetNotes")
    .WithSummary("List all notes (metadata only, no Content)");

app.MapGet("/notes/{id}", (string id, NoteWatcherService watcher) =>
{
    var note = watcher.Notes.Values.FirstOrDefault(n => n.Id == id);
    return note is null ? Results.NotFound() : Results.Ok(note);
})
    .WithName("GetNote")
    .WithSummary("Get a single note by ID including Content");

app.MapPost("/notes", (CreateNoteRequest req, NoteWatcherService watcher, IMarkdownStorageService storage) =>
{
    var id = Guid.NewGuid().ToString();
    var note = new Note
    {
        Id = id,
        Title = req.Title,
        Tags = req.Tags ?? [],
        Color = req.Color ?? string.Empty,
    };
    File.WriteAllText(
        Path.Combine(watcher.NotesDirectory, $"{id}.md"),
        storage.SerializeNote(note));
    return Results.Created($"/notes/{id}", new { id });
})
    .WithName("CreateNote")
    .WithSummary("Create a new note");

app.MapPut("/notes/{id}", (string id, UpdateNoteRequest req, NoteWatcherService watcher, IMarkdownStorageService storage) =>
{
    var entry = watcher.Notes.FirstOrDefault(kv => kv.Value.Id == id);
    if (entry.Value is null) return Results.NotFound();

    var note = entry.Value;
    if (req.Title   is not null) note.Title   = req.Title;
    if (req.Tags    is not null) note.Tags    = req.Tags;
    if (req.Pinned.HasValue)     note.Pinned  = req.Pinned.Value;
    if (req.Color   is not null) note.Color   = req.Color;
    if (req.Content is not null) note.Content = req.Content;

    File.WriteAllText(entry.Key, storage.SerializeNote(note));
    return Results.NoContent();
})
    .WithName("UpdateNote")
    .WithSummary("Partially update a note");

app.MapDelete("/notes/{id}", (string id, NoteWatcherService watcher) =>
{
    var entry = watcher.Notes.FirstOrDefault(kv => kv.Value.Id == id);
    if (entry.Value is null) return Results.NotFound();
    File.Delete(entry.Key);
    return Results.NoContent();
})
    .WithName("DeleteNote")
    .WithSummary("Delete a note");

// ── Search ────────────────────────────────────────────────────────────────────

app.MapGet("/search", (string q, IndexManager indexManager, NoteWatcherService watcher) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var hits = indexManager.Search(q);
    var response = hits
        .Select(hit =>
        {
            var note = watcher.Notes.Values.FirstOrDefault(n => n.Id == hit.Id);
            return note is null ? null : new
            {
                note.Id, note.Title, note.Tags, note.Pinned, note.Color, hit.Snippet,
            };
        })
        .Where(r => r is not null);

    return Results.Ok(response);
})
    .WithName("SearchNotes")
    .WithSummary("Full-text search across Title, Tags, and Content");

app.Run();

record CreateNoteRequest(string Title, List<string>? Tags, string? Color);
record UpdateNoteRequest(string? Title, List<string>? Tags, bool? Pinned, string? Color, string? Content);
