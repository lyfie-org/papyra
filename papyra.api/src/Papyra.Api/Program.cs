using Microsoft.Extensions.FileProviders;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Services;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// ── Centralized storage directories ──────────────────────────────────────────
// Default: <repo-root>/data/{notes,images}
// ContentRootPath in dev = papyra.api/src/Papyra.Api/ → go up 3 levels = repo root
var repoRoot  = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", ".."));
var dataRoot  = Path.Combine(repoRoot, "data");
var notesDir  = builder.Configuration["Storage:NotesDirectory"]  is { Length: > 0 } n ? n : Path.Combine(dataRoot, "notes");
var imagesDir = builder.Configuration["Storage:ImagesDirectory"] is { Length: > 0 } i ? i : Path.Combine(dataRoot, "images");

// Back-fill resolved paths so services that read from IConfiguration pick them up
builder.Configuration["Storage:NotesDirectory"]  = notesDir;
builder.Configuration["Storage:ImagesDirectory"] = imagesDir;

// Create directories on startup — safe to call when they already exist
Directory.CreateDirectory(notesDir);
Directory.CreateDirectory(imagesDir);

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

// Serve data/images/ at /media
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(imagesDir),
    RequestPath  = "/media",
});

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

// ── Image upload ──────────────────────────────────────────────────────────────

app.MapPost("/api/upload/image", async (IFormFile file, IConfiguration configuration) =>
{
    var dir = configuration["Storage:ImagesDirectory"]!;
    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg" };

    var ext = Path.GetExtension(file.FileName);
    if (!allowedExtensions.Contains(ext))
        return Results.BadRequest(new { error = $"File type '{ext}' is not allowed." });

    var fileName = $"{Guid.NewGuid()}{ext}";
    var filePath = Path.Combine(dir, fileName);

    await using var stream = File.Create(filePath);
    await file.CopyToAsync(stream);

    return Results.Ok(new { url = $"/media/{fileName}" });
})
    .WithName("UploadImage")
    .WithSummary("Upload an image; returns its public /media URL")
    .DisableAntiforgery();

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
